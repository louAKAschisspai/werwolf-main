const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = 8080;

app.use(express.static('/app/frontend'));

// --- In-Memory Spielzustand ---
const rooms = {}; // { "room-id": { players: [], gameState: {} } }

// Grace-Period-Timer: Spieler wird erst nach 30s wirklich entfernt
const gracePeriodTimers = new Map();

// Verhindert doppelte DB-Ladevorgänge wenn mehrere Spieler gleichzeitig reconnecten
const roomLoadingPromises = new Map();

// --- Lobby-Leiter ermitteln ---
function getLeaderName(roomId) {
    const players = rooms[roomId]?.gameState?.players;
    if (!players || players.length === 0) return null;
    return players.reduce((min, p) =>
        ((p.joinOrder ?? 0) < (min.joinOrder ?? 0) ? p : min), players[0]
    ).name;
}

function updateLeaderName(roomId) {
    if (!rooms[roomId]) return;
    rooms[roomId].gameState.leaderName = getLeaderName(roomId);
}

// --- System-Chat-Nachricht ---
function systemChat(roomId, text) {
    if (!rooms[roomId]) return;
    if (!rooms[roomId].chatHistory) rooms[roomId].chatHistory = [];
    const msg = { name: null, message: text, system: true };
    rooms[roomId].chatHistory.push(msg);
    if (rooms[roomId].chatHistory.length > 150) rooms[roomId].chatHistory.shift();
    io.to(roomId).emit('chatMessage', msg);
}

// --- Redis-Verbindung + Socket.io Adapter ---
async function connectRedis() {
    const url = process.env.REDIS_URL || 'redis://redis:6379';
    try {
        const pubClient = createClient({ url });
        const subClient = pubClient.duplicate();
        await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(createAdapter(pubClient, subClient));
        console.log('Redis-Adapter verbunden');
    } catch (err) {
        console.warn('Redis nicht erreichbar – Socket.io läuft ohne Adapter:', err.message);
    }
}

// --- Datenbankverbindung ---
let db = null;

async function connectDB() {
    const maxRetries = 15;
    for (let i = 0; i < maxRetries; i++) {
        try {
            db = await mysql.createPool({
                host:     process.env.MYSQL_HOSTNAME || 'db',
                user:     process.env.MYSQL_USER     || 'werwolfuser',
                password: process.env.MYSQL_PASSWORD || 'werwolfpass',
                database: process.env.MYSQL_DATABASE || 'werwolf',
                waitForConnections: true,
                connectionLimit: 10,
            });
            await db.query('SELECT 1');
            console.log('Datenbankverbindung hergestellt');
            return;
        } catch (err) {
            console.log(`DB nicht bereit (Versuch ${i + 1}/${maxRetries}): ${err.message}`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    console.warn('Datenbank nicht erreichbar – Server läuft ohne Persistenz');
    db = null;
}

// --- Spielzustand in DB schreiben ---
async function saveRoomToDB(roomId) {
    if (!db || !rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    try {
        await db.query(
            `INSERT INTO rooms
             (room_id, phase, round, num_werewolves, is_first_day, after_night,
              killed_in_night, voting_result, voting_round, is_werewolf_voting,
              current_voter_index, game_over, announcement,
              active_witch, active_seer, witch_heal_used, witch_poison_used, night_victim)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               phase               = VALUES(phase),
               round               = VALUES(round),
               num_werewolves      = VALUES(num_werewolves),
               is_first_day        = VALUES(is_first_day),
               after_night         = VALUES(after_night),
               killed_in_night     = VALUES(killed_in_night),
               voting_result       = VALUES(voting_result),
               voting_round        = VALUES(voting_round),
               is_werewolf_voting  = VALUES(is_werewolf_voting),
               current_voter_index = VALUES(current_voter_index),
               game_over           = VALUES(game_over),
               announcement        = VALUES(announcement),
               active_witch        = VALUES(active_witch),
               active_seer         = VALUES(active_seer),
               witch_heal_used     = VALUES(witch_heal_used),
               witch_poison_used   = VALUES(witch_poison_used),
               night_victim        = VALUES(night_victim),
               updated_at          = CURRENT_TIMESTAMP`,
            [
                roomId,
                gs.phase,
                gs.round,
                gs.numWerewolves ?? 1,
                gs.isFirstDay ? 1 : 0,
                gs.afterNight ? 1 : 0,
                gs.killedInNight ?? null,
                gs.votingResult  ?? null,
                gs.votingRound,
                gs.isWerewolfVoting ? 1 : 0,
                gs.currentVoterIndex,
                gs.gameOver ? 1 : 0,
                gs.announcement ?? null,
                gs.activeRoles?.witch ? 1 : 0,
                gs.activeRoles?.seer  ? 1 : 0,
                gs.witchHealUsed   ? 1 : 0,
                gs.witchPoisonUsed ? 1 : 0,
                gs.nightVictim ?? null
            ]
        );

        await db.query('DELETE FROM players WHERE room_id = ?', [roomId]);
        if (gs.players.length > 0) {
            const values = gs.players.map(p => [
                roomId,
                p.name,
                p.socketId   ?? null,
                p.role       ?? null,
                p.alive      ? 1 : 0,
                p.joinOrder  ?? 0
            ]);
            await db.query(
                'INSERT INTO players (room_id, name, socket_id, role, alive, join_order) VALUES ?',
                [values]
            );
        }
    } catch (err) {
        console.error('DB-Fehler (saveRoomToDB):', err.message);
    }
}

// --- Stimme in DB protokollieren ---
async function saveVoteToDB(roomId, voterName, target, voteType) {
    if (!db || !rooms[roomId]) return;
    try {
        await db.query(
            'INSERT INTO votes (room_id, round, voter_name, target, vote_type) VALUES (?, ?, ?, ?, ?)',
            [roomId, rooms[roomId].gameState.round, voterName, target, voteType]
        );
    } catch (err) {
        console.error('DB-Fehler (saveVoteToDB):', err.message);
    }
}

// --- Hilfsfunktion: Standard-GameState-Felder ---
function defaultGameState() {
    return {
        phase: 'lobby',
        players: [],
        round: 0,
        gameOver: false,
        currentVoterIndex: 0,
        currentVoters: [],
        votes: {},
        werewolfVotes: {},
        isWerewolfVoting: false,
        votingRound: 1,
        isFirstDay: false,
        afterNight: false,
        killedInNight: null,
        votingResult: null,
        announcement: null,
        leaderName: null,
        activeRoles: { witch: false, seer: false },
        witchHealUsed: false,
        witchPoisonUsed: false,
        nightVictim: null,
    };
}

// --- Aktive Räume beim Serverstart laden ---
async function loadRoomsFromDB() {
    if (!db) return;
    try {
        const [roomRows] = await db.query('SELECT * FROM rooms WHERE game_over = 0');
        for (const row of roomRows) {
            const [playerRows] = await db.query(
                'SELECT * FROM players WHERE room_id = ? ORDER BY join_order ASC',
                [row.room_id]
            );

            const players = playerRows.map(p => ({
                name:      p.name,
                socketId:  p.socket_id,
                role:      p.role,
                alive:     !!p.alive,
                joinOrder: p.join_order
            }));

            rooms[row.room_id] = {
                players: playerRows.map(p => ({ name: p.name, socketId: p.socket_id })),
                chatHistory: [],
                werewolfChatHistory: [],
                gameState: {
                    phase:             row.phase,
                    round:             row.round,
                    numWerewolves:     row.num_werewolves,
                    isFirstDay:        !!row.is_first_day,
                    afterNight:        !!row.after_night,
                    killedInNight:     row.killed_in_night,
                    votingResult:      row.voting_result,
                    votingRound:       row.voting_round,
                    isWerewolfVoting:  !!row.is_werewolf_voting,
                    currentVoterIndex: row.current_voter_index,
                    gameOver:          !!row.game_over,
                    announcement:      row.announcement,
                    activeRoles: {
                        witch: !!row.active_witch,
                        seer:  !!row.active_seer,
                    },
                    witchHealUsed:   !!row.witch_heal_used,
                    witchPoisonUsed: !!row.witch_poison_used,
                    nightVictim:     row.night_victim ?? null,
                    players,
                    currentVoters: [],
                    votes:         {},
                    werewolfVotes: {}
                }
            };

            const gs = rooms[row.room_id].gameState;
            if (gs.phase === 'night') {
                gs.currentVoters = gs.players.filter(p => p.role === 'werewolf' && p.alive);
            } else if (gs.phase === 'voting') {
                gs.currentVoters = gs.players.filter(p => p.alive);
            }
            updateLeaderName(row.room_id);
        }
        console.log(`${roomRows.length} aktive Räume aus der Datenbank geladen`);
    } catch (err) {
        console.error('DB-Fehler (loadRoomsFromDB):', err.message);
    }
}

// --- Einzelnen Raum on-demand aus DB laden ---
async function loadSingleRoomFromDB(roomId) {
    if (rooms[roomId]) return;
    if (roomLoadingPromises.has(roomId)) {
        await roomLoadingPromises.get(roomId);
        return;
    }
    if (!db) return;

    const promise = (async () => {
        try {
            const [roomRows] = await db.query(
                'SELECT * FROM rooms WHERE room_id = ? AND game_over = 0', [roomId]
            );
            if (roomRows.length === 0) return;

            const row = roomRows[0];
            const [playerRows] = await db.query(
                'SELECT * FROM players WHERE room_id = ? ORDER BY join_order ASC', [roomId]
            );

            const players = playerRows.map(p => ({
                name:      p.name,
                socketId:  p.socket_id,
                role:      p.role,
                alive:     !!p.alive,
                joinOrder: p.join_order
            }));

            rooms[roomId] = {
                players: playerRows.map(p => ({ name: p.name, socketId: p.socket_id })),
                chatHistory: [],
                werewolfChatHistory: [],
                gameState: {
                    phase:             row.phase,
                    round:             row.round,
                    numWerewolves:     row.num_werewolves,
                    isFirstDay:        !!row.is_first_day,
                    afterNight:        !!row.after_night,
                    killedInNight:     row.killed_in_night,
                    votingResult:      row.voting_result,
                    votingRound:       row.voting_round,
                    isWerewolfVoting:  !!row.is_werewolf_voting,
                    currentVoterIndex: row.current_voter_index,
                    gameOver:          !!row.game_over,
                    announcement:      row.announcement,
                    activeRoles: {
                        witch: !!row.active_witch,
                        seer:  !!row.active_seer,
                    },
                    witchHealUsed:   !!row.witch_heal_used,
                    witchPoisonUsed: !!row.witch_poison_used,
                    nightVictim:     row.night_victim ?? null,
                    players,
                    currentVoters: [],
                    votes:         {},
                    werewolfVotes: {}
                }
            };

            const gs = rooms[roomId].gameState;
            if (gs.phase === 'night') {
                gs.currentVoters = gs.players.filter(p => p.role === 'werewolf' && p.alive);
            } else if (gs.phase === 'voting') {
                gs.currentVoters = gs.players.filter(p => p.alive);
            }

            updateLeaderName(roomId);
            console.log(`Raum ${roomId} on-demand aus DB geladen (Phase: ${gs.phase})`);
        } catch (err) {
            console.error('DB-Fehler (loadSingleRoomFromDB):', err.message);
        }
    })();

    roomLoadingPromises.set(roomId, promise);
    await promise;
    roomLoadingPromises.delete(roomId);
}

// --- Raum-Zustand vor Spielaktionen aus DB synchronisieren ---
async function refreshRoomFromDB(roomId) {
    if (!db || !rooms[roomId]) return;
    try {
        const [roomRows] = await db.query('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
        if (roomRows.length === 0) return;
        const row = roomRows[0];

        const [playerRows] = await db.query(
            'SELECT * FROM players WHERE room_id = ? ORDER BY join_order ASC', [roomId]
        );

        const [voteRows] = await db.query(
            'SELECT voter_name, target, vote_type FROM votes WHERE room_id = ? AND round = ?',
            [roomId, row.round]
        );

        const gs = rooms[roomId].gameState;
        gs.phase             = row.phase;
        gs.round             = row.round;
        gs.numWerewolves     = row.num_werewolves;
        gs.isFirstDay        = !!row.is_first_day;
        gs.afterNight        = !!row.after_night;
        gs.killedInNight     = row.killed_in_night;
        gs.votingResult      = row.voting_result;
        gs.votingRound       = row.voting_round;
        gs.isWerewolfVoting  = !!row.is_werewolf_voting;
        gs.currentVoterIndex = row.current_voter_index;
        gs.gameOver          = !!row.game_over;
        gs.announcement      = row.announcement;
        gs.activeRoles       = { witch: !!row.active_witch, seer: !!row.active_seer };
        gs.witchHealUsed     = !!row.witch_heal_used;
        gs.witchPoisonUsed   = !!row.witch_poison_used;
        gs.nightVictim       = row.night_victim ?? null;

        // In-Memory-socketIds sichern (darf nicht durch DB-Werte überschrieben werden)
        const liveSocketIds = {};
        gs.players.forEach(p => { liveSocketIds[p.name] = p.socketId; });

        gs.players = playerRows.map(p => ({
            name:      p.name,
            socketId:  liveSocketIds[p.name] ?? p.socket_id,
            role:      p.role,
            alive:     !!p.alive,
            joinOrder: p.join_order
        }));

        if (gs.phase === 'night') {
            gs.currentVoters = gs.players.filter(p => p.role === 'werewolf' && p.alive);
        } else if (gs.phase === 'voting') {
            gs.currentVoters = gs.players.filter(p => p.alive);
        }

        updateLeaderName(roomId);

        gs.votes = {};
        gs.werewolfVotes = {};
        voteRows.forEach(v => {
            if (v.vote_type === 'werewolf') gs.werewolfVotes[v.voter_name] = v.target;
            else gs.votes[v.voter_name] = v.target;
        });

    } catch (err) {
        console.error('DB-Fehler (refreshRoomFromDB):', err.message);
    }
}

// --- Hilfsfunktionen ---

function roleText(role) {
    const map = { werewolf: 'Werwolf', witch: 'Hexe', seer: 'Seherin', villager: 'Dorfbewohner' };
    return map[role] || role || '?';
}

// --- Spiellogik ---

function assignRoles(roomId) {
    const gs = rooms[roomId].gameState;
    const shuffled = [...gs.players].sort(() => Math.random() - 0.5);
    let idx = 0;

    // Werwölfe
    for (let i = 0; i < gs.numWerewolves && idx < shuffled.length; i++) {
        shuffled[idx++].role = 'werewolf';
    }
    // Hexe
    if (gs.activeRoles?.witch && idx < shuffled.length) {
        shuffled[idx++].role = 'witch';
    }
    // Seherin
    if (gs.activeRoles?.seer && idx < shuffled.length) {
        shuffled[idx++].role = 'seer';
    }
    // Rest: Dorfbewohner
    for (; idx < shuffled.length; idx++) {
        shuffled[idx].role = 'villager';
    }

    // Sortiere nach Join-Reihenfolge (absteigend)
    gs.players = shuffled.sort((a, b) => (b.joinOrder || 0) - (a.joinOrder || 0));
}

function killPlayer(roomId, name) {
    const player = rooms[roomId].gameState.players.find(p => p.name === name);
    if (player && player.alive) {
        player.alive = false;
    }
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (room.gameState.gameOver) return;

    const wolves    = room.gameState.players.filter(p => p.role === 'werewolf' && p.alive).length;
    // Village-Team = alle Nicht-Werwölfe (Dorfbewohner + Hexe + Seherin)
    const villagers = room.gameState.players.filter(p => p.role !== 'werewolf' && p.alive).length;

    if (wolves === 0) {
        room.gameState.phase      = 'game_over';
        room.gameState.gameOver   = true;
        room.gameState.announcement = '🎉 Dorfbewohner gewinnen!';
        systemChat(roomId, '🏁 Spiel vorbei! Die Dorfbewohner haben gewonnen!');
    } else if (wolves >= villagers) {
        room.gameState.phase      = 'game_over';
        room.gameState.gameOver   = true;
        room.gameState.announcement = '🐺 Werwölfe gewinnen!';
        systemChat(roomId, '🏁 Spiel vorbei! Die Werwölfe haben gewonnen!');
    }
}

// Werwolf-Abstimmung auswerten → Ergebnis in nightVictim speichern (kein Kill noch)
function resolveWerewolfVotes(roomId) {
    const gs = rooms[roomId].gameState;
    const counts = {};
    Object.values(gs.werewolfVotes).forEach(target => {
        counts[target] = (counts[target] || 0) + 1;
    });

    let maxVotes = 0;
    let killedPlayer = null;
    let ties = [];

    for (let player in counts) {
        if (counts[player] > maxVotes) {
            maxVotes = counts[player];
            killedPlayer = player;
            ties = [player];
        } else if (counts[player] === maxVotes) {
            ties.push(player);
        }
    }

    if (ties.length === 1 && killedPlayer && killedPlayer !== 'Niemanden') {
        gs.nightVictim = killedPlayer; // Kill wird erst nach Hexe/Seherin angewendet
        return true;
    } else if (ties.length === 1 && killedPlayer === 'Niemanden') {
        gs.nightVictim = null;
        return true;
    } else if (gs.votingRound === 1) {
        // Gleichstand in Runde 1 → nochmal abstimmen
        gs.votingRound = 2;
        gs.werewolfVotes = {};
        gs.currentVoterIndex = 0;
        gs.announcement = 'Gleichstand! Werwölfe stimmen erneut ab.';
        io.to(roomId).emit('gameStateUpdated', { gameState: gs });
        return false;
    } else {
        // Gleichstand in Runde 2 → niemand stirbt
        gs.nightVictim = null;
        gs.announcement = 'Erneut Gleichstand – niemand wird getötet.';
        return true;
    }
}

// Nacht-Ergebnisse anwenden (nach Hexe + Seherin)
function applyNightResults(roomId) {
    const gs = rooms[roomId].gameState;

    if (gs.nightVictim) {
        const victim = gs.players.find(p => p.name === gs.nightVictim);
        const victimRole = victim?.role;
        killPlayer(roomId, gs.nightVictim);
        gs.killedInNight = gs.nightVictim;
        systemChat(roomId, `🌅 Neuer Tag – ${gs.nightVictim} (${roleText(victimRole)}) wurde in der Nacht getötet.`);
    } else {
        gs.killedInNight = 'Niemand';
        systemChat(roomId, '🌅 Neuer Tag – alle haben die Nacht überlebt.');
    }

    gs.nightVictim = null;
    gs.phase = 'day';
    gs.afterNight = true;
    checkGameOver(roomId);
}

// Entscheidet nach Werwolf-Vote: Hexe → Seherin → Tag
function advanceFromNight(roomId) {
    const gs = rooms[roomId].gameState;

    const witch = gs.players.find(p => p.role === 'witch' && p.alive);
    if (gs.activeRoles?.witch && witch) {
        gs.phase = 'witch';
        gs.announcement = '🧙 Die Hexe ist am Zug...';
        return;
    }

    const seer = gs.players.find(p => p.role === 'seer' && p.alive);
    if (gs.activeRoles?.seer && seer) {
        gs.phase = 'seer';
        gs.announcement = '🔮 Die Seherin ist am Zug...';
        return;
    }

    applyNightResults(roomId);
}

// Entscheidet nach Hexe: Seherin → Tag
function advanceFromWitch(roomId) {
    const gs = rooms[roomId].gameState;

    const seer = gs.players.find(p => p.role === 'seer' && p.alive);
    if (gs.activeRoles?.seer && seer) {
        gs.phase = 'seer';
        gs.announcement = '🔮 Die Seherin ist am Zug...';
        return;
    }

    applyNightResults(roomId);
}

// Tages-Abstimmung auswerten
function resolveVotes(roomId) {
    const room = rooms[roomId];
    const counts = {};

    Object.values(room.gameState.votes).forEach(target => {
        if (target !== 'Niemanden') {
            counts[target] = (counts[target] || 0) + 1;
        }
    });

    let maxVotes = 0;
    let killedPlayer = null;
    let candidates = [];

    for (let player in counts) {
        if (counts[player] > maxVotes) {
            maxVotes = counts[player];
            killedPlayer = player;
            candidates = [player];
        } else if (counts[player] === maxVotes) {
            candidates.push(player);
        }
    }

    if (killedPlayer && candidates.length === 1) {
        const executed = room.gameState.players.find(p => p.name === killedPlayer);
        const executedRole = executed?.role;
        killPlayer(roomId, killedPlayer);
        room.gameState.votingResult = killedPlayer;
        checkGameOver(roomId);
        if (!room.gameState.gameOver) {
            room.gameState.announcement = `${killedPlayer} wurde getötet!`;
        }
        systemChat(roomId, `⚖️ ${killedPlayer} (${roleText(executedRole)}) wurde durch Abstimmung hingerichtet.`);
    } else {
        room.gameState.votingResult = 'Niemand (Gleichstand)';
        room.gameState.announcement = 'Gleichstand! Niemand wird getötet.';
        systemChat(roomId, '⚖️ Gleichstand – niemand wird hingerichtet.');
    }
}

// Phasenwechsel (nur Leiter)
function nextPhase(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameState.gameOver) return;

    const gs = room.gameState;

    if (gs.phase === 'lobby') {
        gs.phase = 'day';
        gs.isFirstDay = true;

    } else if (gs.phase === 'night') {
        if (gs.currentVoterIndex >= gs.currentVoters.length) {
            const phaseComplete = resolveWerewolfVotes(roomId);
            if (phaseComplete) {
                advanceFromNight(roomId); // setzt phase auf witch/seer/day
            }
        }

    } else if (gs.phase === 'witch') {
        // Leiter kann Hexen-Phase überspringen
        advanceFromWitch(roomId);

    } else if (gs.phase === 'seer') {
        // Leiter kann Seherin-Phase überspringen
        applyNightResults(roomId);

    } else if (gs.phase === 'day') {
        if (gs.isFirstDay) {
            gs.isFirstDay = false;
            gs.phase = 'night';
            gs.isWerewolfVoting = true;
            gs.currentVoters = gs.players.filter(p => p.role === 'werewolf' && p.alive);
            gs.currentVoterIndex = 0;
            gs.werewolfVotes = {};
            gs.votingRound = 1;
            gs.nightVictim = null;
        } else if (gs.afterNight) {
            gs.afterNight = false;
            gs.phase = 'voting';
            gs.isWerewolfVoting = false;
            gs.currentVoters = gs.players.filter(p => p.alive);
            gs.currentVoterIndex = 0;
            gs.votes = {};
        }

    } else if (gs.phase === 'voting') {
        if (gs.currentVoterIndex >= gs.currentVoters.length) {
            resolveVotes(roomId);
            if (!gs.gameOver) {
                gs.phase = 'night';
                gs.round++;
                gs.votes = {};
                gs.werewolfVotes = {};
                gs.votingResult = null;
                gs.isWerewolfVoting = true;
                gs.currentVoters = gs.players.filter(p => p.role === 'werewolf' && p.alive);
                gs.currentVoterIndex = 0;
                gs.votingRound = 1;
                gs.afterNight = false;
                gs.nightVictim = null;
            }
        }
    }

    checkGameOver(roomId);
    io.to(roomId).emit('gameStateUpdated', { gameState: gs });
    saveRoomToDB(roomId);

    // Private Hexen-Info senden wenn Hexen-Phase beginnt
    if (gs.phase === 'witch') {
        const witch = gs.players.find(p => p.role === 'witch' && p.alive);
        if (witch?.socketId) {
            io.to(witch.socketId).emit('witchInfo', {
                victim:     gs.nightVictim,
                healUsed:   gs.witchHealUsed,
                poisonUsed: gs.witchPoisonUsed,
            });
        }
    }
}

// --- Socket.io Events ---

io.on('connection', (socket) => {
    console.log('Ein Client verbunden:', socket.id);

    socket.on('joinRoom', async (roomId, playerName) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            await loadSingleRoomFromDB(roomId);
        }

        const timerKey = `${roomId}:${playerName}`;
        if (rooms[roomId]) {
            const existing = rooms[roomId].gameState.players.find(p => p.name === playerName);
            if (existing) {
                if (gracePeriodTimers.has(timerKey)) {
                    clearTimeout(gracePeriodTimers.get(timerKey));
                    gracePeriodTimers.delete(timerKey);
                }

                existing.socketId = socket.id;
                const inList = rooms[roomId].players.find(p => p.name === playerName);
                if (inList) inList.socketId = socket.id;
                const inVoters = rooms[roomId].gameState.currentVoters.find(p => p.name === playerName);
                if (inVoters) inVoters.socketId = socket.id;

                saveRoomToDB(roomId);
                updateLeaderName(roomId);
                socket.emit('gameStateUpdated', { gameState: rooms[roomId].gameState });
                if (rooms[roomId].chatHistory && rooms[roomId].chatHistory.length > 0) {
                    socket.emit('chatHistory', rooms[roomId].chatHistory);
                }
                // Wolf-Chat-Historie nur an Wölfe schicken
                if (existing.role === 'werewolf' &&
                    rooms[roomId].werewolfChatHistory && rooms[roomId].werewolfChatHistory.length > 0) {
                    socket.emit('werewolfChatHistory', rooms[roomId].werewolfChatHistory);
                }

                // Hexen-Info erneut senden falls Hexen-Phase aktiv
                const gs = rooms[roomId].gameState;
                if (gs.phase === 'witch' && existing.role === 'witch') {
                    socket.emit('witchInfo', {
                        victim:     gs.nightVictim,
                        healUsed:   gs.witchHealUsed,
                        poisonUsed: gs.witchPoisonUsed,
                    });
                }

                console.log(`${playerName} hat sich neu verbunden mit Raum ${roomId}`);
                return;
            }
        }

        console.log(`${playerName} tritt Raum ${roomId} bei`);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                chatHistory: [],
                werewolfChatHistory: [],
                gameState: defaultGameState(),
            };
        }

        const joinOrder = rooms[roomId].gameState.players.length;
        rooms[roomId].players.push({ id: socket.id, name: playerName, socketId: socket.id });
        rooms[roomId].gameState.players.push({
            name: playerName, role: null, alive: true,
            socketId: socket.id, joinOrder
        });

        updateLeaderName(roomId);
        io.to(roomId).emit('playerJoined', {
            players: rooms[roomId].gameState.players,
            leaderName: rooms[roomId].gameState.leaderName,
            message: `${playerName} ist beigetreten`
        });

        saveRoomToDB(roomId);
        console.log(`Spieler im Raum ${roomId}:`, rooms[roomId].gameState.players.length);
    });

    socket.on('disconnect', () => {
        console.log('Ein Client getrennt:', socket.id);

        for (let roomId in rooms) {
            const player = rooms[roomId].gameState.players.find(p => p.socketId === socket.id);
            if (!player) continue;

            const playerName = player.name;
            const timerKey = `${roomId}:${playerName}`;

            console.log(`Grace Period gestartet für ${playerName} in Raum ${roomId} (30s)`);

            const timer = setTimeout(() => {
                gracePeriodTimers.delete(timerKey);
                if (!rooms[roomId]) return;

                rooms[roomId].players = rooms[roomId].players.filter(p => p.name !== playerName);
                rooms[roomId].gameState.players = rooms[roomId].gameState.players.filter(p => p.name !== playerName);
                rooms[roomId].gameState.currentVoters = rooms[roomId].gameState.currentVoters.filter(p => p.name !== playerName);

                if (rooms[roomId].players.length === 0) {
                    delete rooms[roomId];
                } else {
                    updateLeaderName(roomId);
                    io.to(roomId).emit('playerLeft', {
                        players: rooms[roomId].gameState.players,
                        leaderName: rooms[roomId].gameState.leaderName
                    });
                    saveRoomToDB(roomId);
                }

                console.log(`${playerName} endgültig aus Raum ${roomId} entfernt`);
            }, 30000);

            gracePeriodTimers.set(timerKey, timer);
            break;
        }
    });

    socket.on('lobbySettings', (roomId, settings) => {
        if (!rooms[roomId]) return;
        if (rooms[roomId].gameState.phase !== 'lobby') return;
        const player = rooms[roomId].gameState.players.find(p => p.socketId === socket.id);
        if (!player || player.name !== getLeaderName(roomId)) return;

        const gs = rooms[roomId].gameState;
        if (typeof settings.numWerewolves === 'number' && settings.numWerewolves >= 1) {
            gs.numWerewolves = settings.numWerewolves;
        }
        if (settings.activeRoles && typeof settings.activeRoles === 'object') {
            gs.activeRoles = {
                witch: !!settings.activeRoles.witch,
                seer:  !!settings.activeRoles.seer,
            };
        }

        io.to(roomId).emit('gameStateUpdated', { gameState: gs });
        saveRoomToDB(roomId);
    });

    socket.on('startGame', (roomId, numWerewolves) => {
        if (!rooms[roomId]) return;
        const player = rooms[roomId].gameState.players.find(p => p.socketId === socket.id);
        if (!player || player.name !== getLeaderName(roomId)) return;

        rooms[roomId].chatHistory = [];
        rooms[roomId].werewolfChatHistory = [];
        const gs = rooms[roomId].gameState;
        gs.numWerewolves     = numWerewolves;
        gs.phase             = 'day';
        gs.isFirstDay        = true;
        gs.round             = 1;
        gs.currentVoters     = [];
        gs.currentVoterIndex = 0;
        gs.votes             = {};
        gs.werewolfVotes     = {};
        gs.isWerewolfVoting  = false;
        gs.votingRound       = 1;
        gs.afterNight        = false;
        gs.killedInNight     = null;
        gs.votingResult      = null;
        gs.announcement      = null;
        gs.gameOver          = false;
        gs.witchHealUsed     = false;
        gs.witchPoisonUsed   = false;
        gs.nightVictim       = null;
        // activeRoles bleibt erhalten (Leader hat sie in Lobby gesetzt)
        gs.players.forEach(p => { p.alive = true; });
        assignRoles(roomId);
        io.to(roomId).emit('gameStateUpdated', { gameState: gs });
        saveRoomToDB(roomId);
    });

    socket.on('nextPhase', async (roomId) => {
        if (!rooms[roomId]) await loadSingleRoomFromDB(roomId);
        if (!rooms[roomId]) return;
        const player = rooms[roomId].gameState.players.find(p => p.socketId === socket.id);
        if (!player || player.name !== getLeaderName(roomId)) return;

        await refreshRoomFromDB(roomId);
        nextPhase(roomId);
    });

    // Hexen-Aktion
    socket.on('witchAction', (roomId, { heal, poisonTarget }) => {
        if (!rooms[roomId]) return;
        const gs = rooms[roomId].gameState;
        if (gs.phase !== 'witch') return;

        const witch = gs.players.find(p => p.socketId === socket.id && p.role === 'witch');
        if (!witch) return;

        // Heiltrank anwenden
        if (heal && !gs.witchHealUsed && gs.nightVictim) {
            gs.nightVictim = null;
            gs.witchHealUsed = true;
        }

        // Gifttrank anwenden
        if (poisonTarget && !gs.witchPoisonUsed) {
            const target = gs.players.find(p => p.name === poisonTarget && p.alive);
            if (target) {
                const poisonRole = target.role;
                killPlayer(roomId, poisonTarget);
                gs.witchPoisonUsed = true;
                checkGameOver(roomId);
                if (!gs.gameOver) {
                    systemChat(roomId, `🧙 Die Hexe hat in der Nacht ${poisonTarget} (${roleText(poisonRole)}) vergiftet.`);
                }
            }
        }

        if (gs.gameOver) {
            io.to(roomId).emit('gameStateUpdated', { gameState: gs });
            saveRoomToDB(roomId);
            return;
        }

        // Weiter zur Seherin oder zum Tag
        advanceFromWitch(roomId);
        io.to(roomId).emit('gameStateUpdated', { gameState: gs });
        saveRoomToDB(roomId);

        // Private Seherin-Phase beginnt (keine extra Info nötig)
    });

    // Seherin-Aktion
    socket.on('seerAction', (roomId, target) => {
        if (!rooms[roomId]) return;
        const gs = rooms[roomId].gameState;
        if (gs.phase !== 'seer') return;

        const seer = gs.players.find(p => p.socketId === socket.id && p.role === 'seer');
        if (!seer) return;

        const targetPlayer = gs.players.find(p => p.name === target && p.alive && p.name !== seer.name);
        if (!targetPlayer) return;

        // Nur für die Seherin sichtbar
        socket.emit('seerResult', { player: target, role: targetPlayer.role });

        applyNightResults(roomId);
        io.to(roomId).emit('gameStateUpdated', { gameState: gs });
        saveRoomToDB(roomId);
    });

    socket.on('returnToLobby', (roomId) => {
        if (!rooms[roomId]) return;
        if (!rooms[roomId].gameState.gameOver) return;
        rooms[roomId].chatHistory = [];

        const gs = rooms[roomId].gameState;
        gs.phase             = 'lobby';
        gs.gameOver          = false;
        gs.round             = 0;
        gs.currentVoters     = [];
        gs.currentVoterIndex = 0;
        gs.votes             = {};
        gs.werewolfVotes     = {};
        gs.isWerewolfVoting  = false;
        gs.votingRound       = 1;
        gs.isFirstDay        = false;
        gs.afterNight        = false;
        gs.killedInNight     = null;
        gs.votingResult      = null;
        gs.announcement      = null;
        gs.witchHealUsed     = false;
        gs.witchPoisonUsed   = false;
        gs.nightVictim       = null;
        gs.players.forEach(p => { p.role = null; p.alive = true; });

        io.to(roomId).emit('gameStateUpdated', { gameState: gs });
        saveRoomToDB(roomId);
    });

    socket.on('leaveRoom', (roomId, playerName) => {
        socket.leave(roomId);
        if (!rooms[roomId]) return;

        const timerKey = `${roomId}:${playerName}`;
        if (gracePeriodTimers.has(timerKey)) {
            clearTimeout(gracePeriodTimers.get(timerKey));
            gracePeriodTimers.delete(timerKey);
        }

        rooms[roomId].players = rooms[roomId].players.filter(p => p.name !== playerName);
        rooms[roomId].gameState.players = rooms[roomId].gameState.players.filter(p => p.name !== playerName);
        rooms[roomId].gameState.currentVoters = rooms[roomId].gameState.currentVoters.filter(p => p.name !== playerName);

        if (rooms[roomId].players.length === 0) {
            delete rooms[roomId];
        } else {
            updateLeaderName(roomId);
            io.to(roomId).emit('playerLeft', {
                players: rooms[roomId].gameState.players,
                leaderName: rooms[roomId].gameState.leaderName
            });
            saveRoomToDB(roomId);
        }
    });

    // Privater Werwolf-Chat (nur Nacht, nur Wölfe)
    socket.on('werewolfChat', (roomId, message) => {
        if (!rooms[roomId]) return;
        const gs = rooms[roomId].gameState;
        if (gs.phase !== 'night') return;

        const player = gs.players.find(p => p.socketId === socket.id);
        if (!player || player.role !== 'werewolf' || !player.alive) return;

        const msg = { name: player.name, message: message.slice(0, 300) };
        if (!rooms[roomId].werewolfChatHistory) rooms[roomId].werewolfChatHistory = [];
        rooms[roomId].werewolfChatHistory.push(msg);
        if (rooms[roomId].werewolfChatHistory.length > 100) rooms[roomId].werewolfChatHistory.shift();

        // Nur an alle Werwölfe senden (lebend und tot)
        gs.players
            .filter(p => p.role === 'werewolf' && p.socketId)
            .forEach(wolf => io.to(wolf.socketId).emit('werewolfChat', msg));
    });

    socket.on('chatMessage', (roomId, message) => {
        if (!rooms[roomId]) return;
        const phase = rooms[roomId].gameState.phase;
        if (phase !== 'day' && phase !== 'voting') return;

        const player = rooms[roomId].gameState.players.find(p => p.socketId === socket.id);
        if (!player) return;

        const msg = { name: player.name, message: message.slice(0, 300), system: false };
        if (!rooms[roomId].chatHistory) rooms[roomId].chatHistory = [];
        rooms[roomId].chatHistory.push(msg);
        if (rooms[roomId].chatHistory.length > 100) rooms[roomId].chatHistory.shift();
        io.to(roomId).emit('chatMessage', msg);
    });

    socket.on('playerVote', async (roomId, target) => {
        if (!rooms[roomId]) await loadSingleRoomFromDB(roomId);
        if (rooms[roomId]) {
            await refreshRoomFromDB(roomId);
            const room = rooms[roomId];
            const voter = room.gameState.currentVoters[room.gameState.currentVoterIndex];

            if (room.gameState.isWerewolfVoting) {
                room.gameState.werewolfVotes[voter.name] = target;
                saveVoteToDB(roomId, voter.name, target, 'werewolf');
            } else {
                room.gameState.votes[voter.name] = target;
                saveVoteToDB(roomId, voter.name, target, 'village');
            }

            room.gameState.currentVoterIndex++;
            io.to(roomId).emit('gameStateUpdated', { gameState: room.gameState });
            saveRoomToDB(roomId);
        }
    });
});

// --- Server starten ---

async function start() {
    await connectRedis();
    await connectDB();
    await loadRoomsFromDB();
    server.listen(PORT, () => {
        console.log(`Server läuft auf http://localhost:${PORT}`);
    });
}

start();
