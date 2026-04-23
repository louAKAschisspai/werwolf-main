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
const rooms = {};

// Grace-Period-Timer: Spieler wird erst nach 30s wirklich entfernt
const gracePeriodTimers = new Map();

// Countdown-Timer pro Raum (Abstimmungs- und Rollen-Timer)
const roomTimers = new Map();

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

// --- Countdown Helpers ---
function startCountdown(roomId, durationSec, onExpire) {
    clearCountdown(roomId);
    const endsAt = Date.now() + durationSec * 1000;
    if (rooms[roomId]?.gameState) {
        rooms[roomId].gameState.countdownEnd = endsAt;
        rooms[roomId].gameState.countdownDuration = durationSec;
    }
    const timer = setTimeout(async () => {
        roomTimers.delete(roomId);
        if (!rooms[roomId]) return;
        await onExpire();
    }, durationSec * 1000);
    roomTimers.set(roomId, timer);
    io.to(roomId).emit('countdownStart', { endsAt, duration: durationSec });
}

function clearCountdown(roomId) {
    if (roomTimers.has(roomId)) {
        clearTimeout(roomTimers.get(roomId));
        roomTimers.delete(roomId);
    }
    if (rooms[roomId]?.gameState) {
        rooms[roomId].gameState.countdownEnd = null;
        rooms[roomId].gameState.countdownDuration = 0;
    }
}

// Personalisierter GameState: votes/loverNames werden je nach Spieler und Phase gefiltert
function buildPlayerGameState(gs, playerName) {
    const isActiveVoting = gs.phase === 'voting' || (gs.phase === 'night' && gs.isWerewolfVoting);
    const isLover = (gs.loverNames || []).includes(playerName);
    const state = Object.assign({}, gs);
    if (isActiveVoting) {
        state.votes = {};
        state.werewolfVotes = {};
    }
    // loverNames nur für Verliebte sichtbar (und für alle bei Game Over)
    state.loverNames = (isLover || gs.gameOver) ? (gs.loverNames || []) : [];
    return state;
}

// --- Broadcast: pro Spieler personalisiert (votes + loverNames privat) ---
function broadcastGameState(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    gs.players.forEach(player => {
        if (player.socketId) {
            io.to(player.socketId).emit('gameStateUpdated', {
                gameState: buildPlayerGameState(gs, player.name)
            });
        }
    });
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
              active_witch, active_seer, witch_heal_used, witch_poison_used, night_victim,
              voting_duration, witch_poison_victim,
              active_hunter, active_amor, lover_names, hunter_revenge_used, after_hunter_revenge)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               phase                = VALUES(phase),
               round                = VALUES(round),
               num_werewolves       = VALUES(num_werewolves),
               is_first_day         = VALUES(is_first_day),
               after_night          = VALUES(after_night),
               killed_in_night      = VALUES(killed_in_night),
               voting_result        = VALUES(voting_result),
               voting_round         = VALUES(voting_round),
               is_werewolf_voting   = VALUES(is_werewolf_voting),
               current_voter_index  = VALUES(current_voter_index),
               game_over            = VALUES(game_over),
               announcement         = VALUES(announcement),
               active_witch         = VALUES(active_witch),
               active_seer          = VALUES(active_seer),
               witch_heal_used      = VALUES(witch_heal_used),
               witch_poison_used    = VALUES(witch_poison_used),
               night_victim         = VALUES(night_victim),
               voting_duration      = VALUES(voting_duration),
               witch_poison_victim  = VALUES(witch_poison_victim),
               active_hunter        = VALUES(active_hunter),
               active_amor          = VALUES(active_amor),
               lover_names          = VALUES(lover_names),
               hunter_revenge_used  = VALUES(hunter_revenge_used),
               after_hunter_revenge = VALUES(after_hunter_revenge),
               updated_at           = CURRENT_TIMESTAMP`,
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
                0,
                gs.gameOver ? 1 : 0,
                gs.announcement ?? null,
                gs.activeRoles?.witch   ? 1 : 0,
                gs.activeRoles?.seer    ? 1 : 0,
                gs.witchHealUsed   ? 1 : 0,
                gs.witchPoisonUsed ? 1 : 0,
                gs.nightVictim ?? null,
                gs.votingDuration ?? 60,
                gs.witchPoisonVictim ?? null,
                gs.activeRoles?.hunter  ? 1 : 0,
                gs.activeRoles?.amor    ? 1 : 0,
                (gs.loverNames || []).join(',') || null,
                gs.hunterRevengeUsed  ? 1 : 0,
                gs.afterHunterRevenge ?? null,
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
        hasVotedNames: [],       // Wer hat schon abgestimmt (ohne Ziel, für alle sichtbar)
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
        witchPoisonVictim: null, // Giftopfer der Hexe (wird erst bei Tag aufgedeckt)
        votingDuration: 60,      // Abstimmungszeit in Sekunden (30/60/90)
        countdownEnd: null,      // Unix-Timestamp (ms) wann Countdown endet
        countdownDuration: 0,    // Gesamtdauer des laufenden Countdowns
        dayPhaseStart: null,     // Timestamp (ms) wann Tag-Phase begann (für 15s Mindestwartezeit)
        loverNames: [],          // [name1, name2] – das Liebespaar (privat, nur für Verliebte)
        hunterRevengeUsed: false,// Hat der Jäger sein Rache-Schuss genutzt?
        afterHunterRevenge: null,// Wohin nach Jäger-Rache: 'day' | 'result'
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
                        witch:  !!row.active_witch,
                        seer:   !!row.active_seer,
                        hunter: !!row.active_hunter,
                        amor:   !!row.active_amor,
                    },
                    witchHealUsed:       !!row.witch_heal_used,
                    witchPoisonUsed:     !!row.witch_poison_used,
                    nightVictim:         row.night_victim ?? null,
                    votingDuration:      row.voting_duration ?? 60,
                    witchPoisonVictim:   row.witch_poison_victim ?? null,
                    loverNames:          row.lover_names ? row.lover_names.split(',') : [],
                    hunterRevengeUsed:   !!row.hunter_revenge_used,
                    afterHunterRevenge:  row.after_hunter_revenge ?? null,
                    players,
                    currentVoters:    [],
                    votes:            {},
                    werewolfVotes:    {},
                    hasVotedNames:    [],
                    countdownEnd:     null,
                    countdownDuration: 0,
                }
            };

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
                        witch:  !!row.active_witch,
                        seer:   !!row.active_seer,
                        hunter: !!row.active_hunter,
                        amor:   !!row.active_amor,
                    },
                    witchHealUsed:       !!row.witch_heal_used,
                    witchPoisonUsed:     !!row.witch_poison_used,
                    nightVictim:         row.night_victim ?? null,
                    votingDuration:      row.voting_duration ?? 60,
                    witchPoisonVictim:   row.witch_poison_victim ?? null,
                    loverNames:          row.lover_names ? row.lover_names.split(',') : [],
                    hunterRevengeUsed:   !!row.hunter_revenge_used,
                    afterHunterRevenge:  row.after_hunter_revenge ?? null,
                    players,
                    currentVoters:    [],
                    votes:            {},
                    werewolfVotes:    {},
                    hasVotedNames:    [],
                    countdownEnd:     null,
                    countdownDuration: 0,
                }
            };

            updateLeaderName(roomId);
            console.log(`Raum ${roomId} on-demand aus DB geladen (Phase: ${rooms[roomId].gameState.phase})`);
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
        gs.witchHealUsed      = !!row.witch_heal_used;
        gs.witchPoisonUsed    = !!row.witch_poison_used;
        gs.nightVictim        = row.night_victim ?? null;
        gs.votingDuration     = row.voting_duration ?? 60;
        gs.witchPoisonVictim  = row.witch_poison_victim ?? null;
        gs.activeRoles        = {
            witch:  !!row.active_witch,
            seer:   !!row.active_seer,
            hunter: !!row.active_hunter,
            amor:   !!row.active_amor,
        };
        gs.loverNames         = row.lover_names ? row.lover_names.split(',') : [];
        gs.hunterRevengeUsed  = !!row.hunter_revenge_used;
        gs.afterHunterRevenge = row.after_hunter_revenge ?? null;

        // In-Memory-socketIds sichern
        const liveSocketIds = {};
        gs.players.forEach(p => { liveSocketIds[p.name] = p.socketId; });

        gs.players = playerRows.map(p => ({
            name:      p.name,
            socketId:  liveSocketIds[p.name] ?? p.socket_id,
            role:      p.role,
            alive:     !!p.alive,
            joinOrder: p.join_order
        }));

        updateLeaderName(roomId);

        gs.votes = {};
        gs.werewolfVotes = {};
        voteRows.forEach(v => {
            if (v.vote_type === 'werewolf') gs.werewolfVotes[v.voter_name] = v.target;
            else gs.votes[v.voter_name] = v.target;
        });

        // hasVotedNames aus geladenen Stimmen rekonstruieren
        if (gs.phase === 'voting') {
            gs.hasVotedNames = Object.keys(gs.votes);
        } else if (gs.phase === 'night' && gs.isWerewolfVoting) {
            gs.hasVotedNames = Object.keys(gs.werewolfVotes);
        }

    } catch (err) {
        console.error('DB-Fehler (refreshRoomFromDB):', err.message);
    }
}

// --- Hilfsfunktionen ---

function roleText(role) {
    const map = { werewolf: 'Werwolf', witch: 'Hexe', seer: 'Seherin', villager: 'Dorfbewohner', hunter: 'Jäger', amor: 'Amor' };
    return map[role] || role || '?';
}

// Hilfsfunktion: Ist der Jäger gestorben und hat noch nicht geschossen?
function isHunterDead(roomId) {
    const gs = rooms[roomId].gameState;
    if (gs.hunterRevengeUsed || !gs.activeRoles?.hunter) return false;
    const hunter = gs.players.find(p => p.role === 'hunter');
    return !!(hunter && !hunter.alive);
}

// Nacht-Phase starten (nach Amor oder direkt beim ersten Tag)
function startNightPhase(roomId) {
    const gs = rooms[roomId].gameState;
    gs.phase = 'night';
    gs.isWerewolfVoting = true;
    gs.currentVoters = gs.players.filter(p => p.role === 'werewolf' && p.alive);
    gs.currentVoterIndex = 0;
    gs.werewolfVotes = {};
    gs.hasVotedNames = [];
    gs.votingRound = 1;
    gs.nightVictim = null;
    gs.announcement = null;
    broadcastGameState(roomId);
    saveRoomToDB(roomId);
    startCountdown(roomId, 60, () => resolveWerewolfPhase(roomId));
}

// Nach Jäger-Rache zur nächsten Phase wechseln
function proceedAfterHunterRevenge(roomId) {
    const gs = rooms[roomId].gameState;
    const next = gs.afterHunterRevenge || 'day';
    gs.afterHunterRevenge = null;
    gs.hunterRevengeUsed = true;

    if (next === 'day') {
        gs.phase = 'day';
        gs.afterNight = true;
        gs.announcement = '🌅 Das Dorf erwacht.';
        gs.dayPhaseStart = Date.now();
        broadcastGameState(roomId);
        saveRoomToDB(roomId);
        startCountdown(roomId, 90, () => dayTimeout(roomId));
    } else {
        // 'result'
        gs.phase = 'result';
        broadcastGameState(roomId);
        saveRoomToDB(roomId);
        startCountdown(roomId, 15, () => resultTimeout(roomId));
    }
}

// --- Spiellogik ---

function assignRoles(roomId) {
    const gs = rooms[roomId].gameState;
    const shuffled = [...gs.players].sort(() => Math.random() - 0.5);
    let idx = 0;

    for (let i = 0; i < gs.numWerewolves && idx < shuffled.length; i++) {
        shuffled[idx++].role = 'werewolf';
    }
    if (gs.activeRoles?.amor && idx < shuffled.length) {
        shuffled[idx++].role = 'amor';
    }
    if (gs.activeRoles?.witch && idx < shuffled.length) {
        shuffled[idx++].role = 'witch';
    }
    if (gs.activeRoles?.seer && idx < shuffled.length) {
        shuffled[idx++].role = 'seer';
    }
    if (gs.activeRoles?.hunter && idx < shuffled.length) {
        shuffled[idx++].role = 'hunter';
    }
    for (; idx < shuffled.length; idx++) {
        shuffled[idx].role = 'villager';
    }

    gs.players = shuffled.sort((a, b) => (b.joinOrder || 0) - (a.joinOrder || 0));
}

function killPlayer(roomId, name) {
    const gs = rooms[roomId].gameState;
    const player = gs.players.find(p => p.name === name);
    if (!player || !player.alive) return;
    player.alive = false;

    // Liebesketten-Reaktion: stirbt ein Verliebter, stirbt der Partner auch
    if (gs.loverNames && gs.loverNames.includes(name)) {
        const partnerName = gs.loverNames.find(n => n !== name);
        const partner = gs.players.find(p => p.name === partnerName);
        if (partner && partner.alive) {
            partner.alive = false;
            systemChat(roomId, `💔 ${partnerName} (${roleText(partner.role)}) stirbt vor Liebeskummer.`);
        }
    }
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (room.gameState.gameOver) return;

    const gs = room.gameState;
    const alive    = gs.players.filter(p => p.alive);
    const wolves   = alive.filter(p => p.role === 'werewolf').length;
    const others   = alive.filter(p => p.role !== 'werewolf').length;

    // Spiel endet nur wenn Standardbedingung erfüllt ist
    if (wolves !== 0 && wolves < others) return;

    // Beide Verliebten noch am Leben? → Liebespaar gewinnt
    const loverNames = gs.loverNames || [];
    if (loverNames.length === 2) {
        const bothAlive = loverNames.every(n => gs.players.find(p => p.name === n)?.alive);
        if (bothAlive) {
            triggerGameOverResults(roomId, `💕 Das Liebespaar gewinnt!`,
                `🏁 Spiel vorbei! Das Liebespaar (${loverNames[0]} & ${loverNames[1]}) hat gewonnen!`);
            return;
        }
    }

    if (wolves === 0) {
        triggerGameOverResults(roomId, '🎉 Dorfbewohner gewinnen!',
            '🏁 Spiel vorbei! Die Dorfbewohner haben gewonnen!');
    } else {
        triggerGameOverResults(roomId, '🐺 Werwölfe gewinnen!',
            '🏁 Spiel vorbei! Die Werwölfe haben gewonnen!');
    }
}

// Zeige 90s lang die Ergebnisse, dann zum echten Game Over
function triggerGameOverResults(roomId, announcement, chatMsg) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    gs.phase = 'game_over_results';
    gs.gameOver = false; // noch nicht wirklich vorbei
    gs.announcement = announcement;
    gs.dayPhaseStart = Date.now(); // Für 15s Mindestwartezeit vor forcieren
    systemChat(roomId, chatMsg);
    broadcastGameState(roomId);
    saveRoomToDB(roomId);
    startCountdown(roomId, 15, () => finalizeGameOver(roomId));
}

// Nach 15s Ergebnis-Phase zum echten Game Over
async function finalizeGameOver(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    if (gs.phase !== 'game_over_results') return;

    gs.gameOver = true;
    broadcastGameState(roomId);
    saveRoomToDB(roomId);
}

// Nacht-Ergebnisse anwenden (nach Hexe + Seherin)
function applyNightResults(roomId) {
    const gs = rooms[roomId].gameState;

    let anyKilled = false;

    if (gs.nightVictim) {
        const victim = gs.players.find(p => p.name === gs.nightVictim);
        const victimRole = victim?.role;
        killPlayer(roomId, gs.nightVictim);
        gs.killedInNight = gs.nightVictim;
        systemChat(roomId, `🌅 Neuer Tag – ${gs.nightVictim} (${roleText(victimRole)}) wurde von den Werwölfen getötet.`);
        anyKilled = true;
    }

    // Hexen-Gift bei Tagesanbruch anwenden
    if (gs.witchPoisonVictim) {
        const poisonVictim = gs.players.find(p => p.name === gs.witchPoisonVictim);
        const poisonRole = poisonVictim?.role;
        killPlayer(roomId, gs.witchPoisonVictim);
        systemChat(roomId, `☠️ ${gs.witchPoisonVictim} (${roleText(poisonRole)}) wurde von der Hexe vergiftet.`);
        gs.witchPoisonVictim = null;
        anyKilled = true;
    }

    if (!anyKilled) {
        gs.killedInNight = 'Niemand';
        systemChat(roomId, '🌅 Neuer Tag – alle haben die Nacht überlebt.');
    }

    gs.nightVictim = null;
    checkGameOver(roomId);
    if (gs.gameOver || gs.phase === 'game_over_results') return;

    // Jäger gestorben? → Rache-Phase einlegen
    if (isHunterDead(roomId)) {
        gs.phase = 'hunter_revenge';
        gs.afterHunterRevenge = 'day';
        gs.announcement = '🎯 Der Jäger darf noch ein letztes Opfer wählen!';
        startCountdown(roomId, 60, () => hunterRevengeTimeout(roomId));
    } else {
        gs.phase = 'day';
        gs.afterNight = true;
        gs.announcement = '🌅 Das Dorf erwacht.';
        gs.dayPhaseStart = Date.now();
        startCountdown(roomId, 90, () => dayTimeout(roomId));
    }
}

// Entscheidet nach Werwolf-Vote: Hexe → Seherin → Tag. Gibt neue Phase zurück.
function advanceFromNight(roomId) {
    const gs = rooms[roomId].gameState;

    const witch = gs.players.find(p => p.role === 'witch' && p.alive);
    if (gs.activeRoles?.witch && witch) {
        gs.phase = 'witch';
        gs.announcement = '🧙 Die Hexe ist am Zug...';
        return 'witch';
    }

    const seer = gs.players.find(p => p.role === 'seer' && p.alive);
    if (gs.activeRoles?.seer && seer) {
        gs.phase = 'seer';
        gs.announcement = '🔮 Die Seherin ist am Zug...';
        return 'seer';
    }

    applyNightResults(roomId);
    return 'day';
}

// Entscheidet nach Hexe: Seherin → Tag. Gibt neue Phase zurück.
function advanceFromWitch(roomId) {
    const gs = rooms[roomId].gameState;

    const seer = gs.players.find(p => p.role === 'seer' && p.alive);
    if (gs.activeRoles?.seer && seer) {
        gs.phase = 'seer';
        gs.announcement = '🔮 Die Seherin ist am Zug...';
        return 'seer';
    }

    applyNightResults(roomId);
    return 'day';
}

// --- Tages-Abstimmung auswerten (Gleichstand = niemand stirbt) ---
function resolveVotes(roomId) {
    const gs = rooms[roomId].gameState;
    const counts = {};

    Object.values(gs.votes).forEach(target => {
        if (target !== 'Niemanden') {
            counts[target] = (counts[target] || 0) + 1;
        }
    });

    let maxVotes = 0;
    let winner = null;
    let candidates = [];

    for (const player in counts) {
        if (counts[player] > maxVotes) {
            maxVotes = counts[player];
            winner = player;
            candidates = [player];
        } else if (counts[player] === maxVotes) {
            candidates.push(player);
        }
    }

    if (winner && candidates.length === 1) {
        const executed = gs.players.find(p => p.name === winner);
        const executedRole = executed?.role;
        killPlayer(roomId, winner);
        gs.votingResult = winner;
        checkGameOver(roomId);
        if (!gs.gameOver) {
            gs.announcement = `⚖️ ${winner} (${roleText(executedRole)}) wurde durch Abstimmung hingerichtet.`;
        }
        systemChat(roomId, `⚖️ ${winner} (${roleText(executedRole)}) wurde durch Abstimmung hingerichtet.`);
    } else {
        gs.votingResult = 'Niemand';
        gs.announcement = '⚖️ Gleichstand – niemand wird hingerichtet.';
        systemChat(roomId, '⚖️ Gleichstand – niemand wird hingerichtet.');
    }
}

// --- Werwolf-Abstimmung auswerten und Phase weiterführen ---
async function resolveWerewolfPhase(roomId) {
    if (!rooms[roomId]) return;
    await refreshRoomFromDB(roomId);
    const gs = rooms[roomId].gameState;

    // Guard: Sicherstellen dass wir noch in der richtigen Phase sind
    if (gs.phase !== 'night' || !gs.isWerewolfVoting) return;

    clearCountdown(roomId);

    // Fehlende Wolf-Stimmen als 'Niemanden' auffüllen
    const aliveWolves = gs.players.filter(p => p.role === 'werewolf' && p.alive);
    aliveWolves.forEach(wolf => {
        if (!gs.werewolfVotes[wolf.name]) {
            gs.werewolfVotes[wolf.name] = 'Niemanden';
        }
    });
    gs.hasVotedNames = [];

    // Stimmen zählen
    const counts = {};
    Object.values(gs.werewolfVotes).forEach(target => {
        if (target !== 'Niemanden') {
            counts[target] = (counts[target] || 0) + 1;
        }
    });

    let maxVotes = 0;
    let winner = null;
    let candidates = [];

    for (const player in counts) {
        if (counts[player] > maxVotes) {
            maxVotes = counts[player];
            winner = player;
            candidates = [player];
        } else if (counts[player] === maxVotes) {
            candidates.push(player);
        }
    }

    // Gleichstand nur wenn mehrere echte Kandidaten gleich viele Stimmen haben
    const isTie = candidates.length > 1;

    if (isTie && gs.votingRound === 1) {
        // Gleichstand in Runde 1 → nochmal abstimmen mit neuem Countdown
        gs.votingRound = 2;
        gs.werewolfVotes = {};
        gs.hasVotedNames = [];
        gs.announcement = '⚖️ Gleichstand! Werwölfe stimmen erneut ab.';

        // Alte Werwolf-Stimmen aus DB löschen für saubere Neuabstimmung
        if (db) {
            try {
                await db.query(
                    'DELETE FROM votes WHERE room_id = ? AND round = ? AND vote_type = ?',
                    [roomId, gs.round, 'werewolf']
                );
            } catch (e) { /* ignorieren */ }
        }

        broadcastGameState(roomId);
        saveRoomToDB(roomId);
        startCountdown(roomId, 60, () => resolveWerewolfPhase(roomId));
        return;
    }

    // Ergebnis festlegen
    gs.nightVictim = (!isTie && winner) ? winner : null;
    if (isTie) gs.announcement = '⚖️ Erneut Gleichstand – niemand wird getötet.';

    const newPhase = advanceFromNight(roomId);
    checkGameOver(roomId);
    broadcastGameState(roomId);
    saveRoomToDB(roomId);

    if (!gs.gameOver) {
        if (newPhase === 'witch') {
            const witch = gs.players.find(p => p.role === 'witch' && p.alive);
            if (witch?.socketId) {
                io.to(witch.socketId).emit('witchInfo', {
                    victim:     gs.nightVictim,
                    healUsed:   gs.witchHealUsed,
                    poisonUsed: gs.witchPoisonUsed,
                });
            }
            startCountdown(roomId, 90, () => witchTimeout(roomId));
        } else if (newPhase === 'seer') {
            startCountdown(roomId, 90, () => seerTimeout(roomId));
        }
    }
}

// --- Tages-Abstimmung automatisch beenden ---
async function resolveVotingPhase(roomId) {
    if (!rooms[roomId]) return;
    await refreshRoomFromDB(roomId);
    const gs = rooms[roomId].gameState;

    // Guard: Nur auflösen wenn noch in Voting-Phase
    if (gs.phase !== 'voting') return;

    clearCountdown(roomId);

    // Fehlende Stimmen als 'Niemanden' auffüllen
    const alivePlayers = gs.players.filter(p => p.alive);
    alivePlayers.forEach(p => {
        if (!gs.votes[p.name]) gs.votes[p.name] = 'Niemanden';
    });
    gs.hasVotedNames = [];

    resolveVotes(roomId);
    gs.votes = {};
    gs.werewolfVotes = {};
    gs.hasVotedNames = [];

    // Wenn game_over_results Phase erreicht wurde, stoppen
    if (gs.phase === 'game_over_results') {
        broadcastGameState(roomId);
        saveRoomToDB(roomId);
        return;
    }

    // Jäger gestorben? → Rache-Phase einlegen
    if (isHunterDead(roomId)) {
        gs.phase = 'hunter_revenge';
        gs.afterHunterRevenge = 'result';
        gs.announcement = '🎯 Der Jäger darf noch ein letztes Opfer wählen!';
        broadcastGameState(roomId);
        saveRoomToDB(roomId);
        startCountdown(roomId, 60, () => hunterRevengeTimeout(roomId));
        return;
    }

    // Kurze Ergebnis-Phase (15s) bevor die Nacht beginnt
    gs.phase = 'result';
    broadcastGameState(roomId);
    saveRoomToDB(roomId);
    startCountdown(roomId, 15, () => resultTimeout(roomId));
}

// --- Ergebnis-Phase abgelaufen: Weiter zur Nacht ---
async function resultTimeout(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    if (gs.phase !== 'result') return;

    gs.phase = 'night';
    gs.round++;
    gs.votingResult = null;
    gs.isWerewolfVoting = true;
    gs.currentVoters = gs.players.filter(p => p.role === 'werewolf' && p.alive);
    gs.currentVoterIndex = 0;
    gs.votingRound = 1;
    gs.afterNight = false;
    gs.nightVictim = null;
    gs.announcement = null;

    broadcastGameState(roomId);
    saveRoomToDB(roomId);

    if (!gs.gameOver) {
        startCountdown(roomId, 60, () => resolveWerewolfPhase(roomId));
    }
}

// --- Jäger hat nicht gehandelt: Phase automatisch weiterführen ---
async function hunterRevengeTimeout(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    if (gs.phase !== 'hunter_revenge') return;

    systemChat(roomId, '🎯 Der Jäger hat sein Recht nicht genutzt.');
    proceedAfterHunterRevenge(roomId);
}

// --- Amor-Phase abgelaufen: direkt zur Nacht ---
async function amorTimeout(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    if (gs.phase !== 'amor') return;

    startNightPhase(roomId);
}

// --- Amor-Benachrichtigungs-Phase abgelaufen: zur Nacht ---
async function amorNotifyTimeout(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    if (gs.phase !== 'amor_notify') return;

    startNightPhase(roomId);
}

// --- Hexe hat nicht gehandelt: Phase automatisch weiterschieben ---
async function witchTimeout(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    if (gs.phase !== 'witch') return;

    const newPhase = advanceFromWitch(roomId);
    broadcastGameState(roomId);
    saveRoomToDB(roomId);

    if (!gs.gameOver && newPhase === 'seer') {
        startCountdown(roomId, 90, () => seerTimeout(roomId));
    }
}

// --- Tag-Diskussion abgelaufen: automatisch zur Abstimmung ---
async function dayTimeout(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    if (gs.phase !== 'day' || !gs.afterNight) return;

    gs.afterNight = false;
    gs.phase = 'voting';
    gs.isWerewolfVoting = false;
    gs.currentVoters = gs.players.filter(p => p.alive);
    gs.currentVoterIndex = 0;
    gs.votes = {};
    gs.hasVotedNames = [];
    gs.announcement = null;

    broadcastGameState(roomId);
    saveRoomToDB(roomId);
    startCountdown(roomId, gs.votingDuration || 60, () => resolveVotingPhase(roomId));
}

// --- Seherin hat nicht gehandelt: Phase automatisch weiterschieben ---
async function seerTimeout(roomId) {
    if (!rooms[roomId]) return;
    const gs = rooms[roomId].gameState;
    if (gs.phase !== 'seer') return;

    applyNightResults(roomId);
    broadcastGameState(roomId);
    saveRoomToDB(roomId);
}

// --- Phasenwechsel (nur Leiter) ---
function nextPhase(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameState.gameOver) return;

    const gs = room.gameState;

    if (gs.phase === 'lobby') {
        gs.phase = 'day';
        gs.isFirstDay = true;

    } else if (gs.phase === 'game_over_results') {
        // 15s Mindestwartezeit prüfen
        if (gs.dayPhaseStart && Date.now() - gs.dayPhaseStart < 15000) {
            return; // Zu früh – ignorieren
        }
        clearCountdown(roomId);
        finalizeGameOver(roomId);
        return;

    } else if (gs.phase === 'day' && gs.isFirstDay) {
        // Erste Nacht – ggf. Amor zuerst
        gs.isFirstDay = false;
        const amor = gs.players.find(p => p.role === 'amor' && p.alive);
        if (gs.activeRoles?.amor && amor) {
            gs.phase = 'amor';
            gs.announcement = '💘 Amor ist am Zug...';
            broadcastGameState(roomId);
            saveRoomToDB(roomId);
            startCountdown(roomId, 90, () => amorTimeout(roomId));
            return;
        }
        // Kein Amor → direkt Nacht
        startNightPhase(roomId);
        return;

    } else if (gs.phase === 'amor') {
        // Leiter überspringt Amor-Phase
        clearCountdown(roomId);
        startNightPhase(roomId);
        return;

    } else if (gs.phase === 'day' && gs.afterNight) {
        // 15s Mindestdiskussionszeit prüfen
        if (gs.dayPhaseStart && Date.now() - gs.dayPhaseStart < 15000) {
            return; // Zu früh – ignorieren
        }
        clearCountdown(roomId); // 90s Tages-Timer stoppen
        // Tages-Abstimmung starten
        gs.afterNight = false;
        gs.phase = 'voting';
        gs.isWerewolfVoting = false;
        gs.currentVoters = gs.players.filter(p => p.alive);
        gs.currentVoterIndex = 0;
        gs.votes = {};
        gs.hasVotedNames = [];
        gs.announcement = null;

    } else if (gs.phase === 'witch') {
        // Leiter überspringt Hexen-Phase
        clearCountdown(roomId);
        const newPhase = advanceFromWitch(roomId);
        broadcastGameState(roomId);
        saveRoomToDB(roomId);
        if (!gs.gameOver && newPhase === 'seer') {
            startCountdown(roomId, 90, () => seerTimeout(roomId));
        }
        return;

    } else if (gs.phase === 'seer') {
        // Leiter überspringt Seherin-Phase
        clearCountdown(roomId);
        applyNightResults(roomId);
        broadcastGameState(roomId);
        saveRoomToDB(roomId);
        return;
    }

    checkGameOver(roomId);
    broadcastGameState(roomId);
    saveRoomToDB(roomId);

    // Countdown für neue Phase starten
    if (!gs.gameOver) {
        if (gs.phase === 'night') {
            startCountdown(roomId, 60, () => resolveWerewolfPhase(roomId));
        } else if (gs.phase === 'voting') {
            startCountdown(roomId, gs.votingDuration || 60, () => resolveVotingPhase(roomId));
        }
    }

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
        startCountdown(roomId, 90, () => witchTimeout(roomId));
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

                saveRoomToDB(roomId);
                updateLeaderName(roomId);

                const gs = rooms[roomId].gameState;

                // Personalisierten GameState senden (votes + loverNames je nach Spieler)
                socket.emit('gameStateUpdated', {
                    gameState: buildPlayerGameState(gs, playerName)
                });

                if (rooms[roomId].chatHistory && rooms[roomId].chatHistory.length > 0) {
                    socket.emit('chatHistory', rooms[roomId].chatHistory);
                }

                // Wolf-Chat-Historie nur an Wölfe schicken
                if (existing.role === 'werewolf' &&
                    rooms[roomId].werewolfChatHistory && rooms[roomId].werewolfChatHistory.length > 0) {
                    socket.emit('werewolfChatHistory', rooms[roomId].werewolfChatHistory);
                }

                // Hexen-Info erneut senden falls Hexen-Phase aktiv
                if (gs.phase === 'witch' && existing.role === 'witch') {
                    socket.emit('witchInfo', {
                        victim:     gs.nightVictim,
                        healUsed:   gs.witchHealUsed,
                        poisonUsed: gs.witchPoisonUsed,
                    });
                }

                // Amor-Info erneut senden falls Spieler verliebt ist
                if ((gs.loverNames || []).includes(playerName)) {
                    const partnerName = gs.loverNames.find(n => n !== playerName);
                    socket.emit('loverInfo', { partnerName });
                }

                // Countdown-Info senden falls aktiv
                if (gs.countdownEnd && gs.countdownEnd > Date.now()) {
                    socket.emit('countdownStart', {
                        endsAt:   gs.countdownEnd,
                        duration: gs.countdownDuration,
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

                if (rooms[roomId].players.length === 0) {
                    clearCountdown(roomId);
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
                witch:  !!settings.activeRoles.witch,
                seer:   !!settings.activeRoles.seer,
                hunter: !!settings.activeRoles.hunter,
                amor:   !!settings.activeRoles.amor,
            };
        }
        if (typeof settings.votingDuration === 'number' && [30, 60, 90].includes(settings.votingDuration)) {
            gs.votingDuration = settings.votingDuration;
        }

        broadcastGameState(roomId);
        saveRoomToDB(roomId);
    });

    socket.on('startGame', (roomId, numWerewolves) => {
        if (!rooms[roomId]) return;
        const player = rooms[roomId].gameState.players.find(p => p.socketId === socket.id);
        if (!player || player.name !== getLeaderName(roomId)) return;

        clearCountdown(roomId);
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
        gs.hasVotedNames     = [];
        gs.isWerewolfVoting  = false;
        gs.votingRound       = 1;
        gs.afterNight        = false;
        gs.killedInNight     = null;
        gs.votingResult      = null;
        gs.announcement      = null;
        gs.gameOver          = false;
        gs.witchHealUsed      = false;
        gs.witchPoisonUsed    = false;
        gs.nightVictim        = null;
        gs.witchPoisonVictim  = null;
        gs.loverNames         = [];
        gs.hunterRevengeUsed  = false;
        gs.afterHunterRevenge = null;
        gs.countdownEnd       = null;
        gs.countdownDuration  = 0;
        gs.dayPhaseStart      = null;
        // votingDuration bleibt erhalten (Leiter hat es in Lobby gesetzt)
        // activeRoles bleibt erhalten
        gs.players.forEach(p => { p.alive = true; });
        assignRoles(roomId);
        broadcastGameState(roomId);
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

    // Simultane Abstimmung (ersetzt playerVote)
    socket.on('castVote', async (roomId, target) => {
        if (!rooms[roomId]) await loadSingleRoomFromDB(roomId);
        if (!rooms[roomId]) return;

        const gs = rooms[roomId].gameState;
        const player = gs.players.find(p => p.socketId === socket.id);
        if (!player || !player.alive) return;

        const isWerewolfPhase = gs.phase === 'night' && gs.isWerewolfVoting;
        const isVotingPhase   = gs.phase === 'voting';
        if (!isWerewolfPhase && !isVotingPhase) return;
        if (isWerewolfPhase && player.role !== 'werewolf') return;

        const voteMap  = isWerewolfPhase ? gs.werewolfVotes : gs.votes;
        if (voteMap[player.name]) return; // Bereits abgestimmt

        // Ziel validieren
        const validTargets = isWerewolfPhase
            ? gs.players.filter(p => p.alive && p.role !== 'werewolf').map(p => p.name).concat(['Niemanden'])
            : gs.players.filter(p => p.alive).map(p => p.name).concat(['Niemanden']);
        if (!validTargets.includes(target)) return;

        voteMap[player.name] = target;
        if (!gs.hasVotedNames) gs.hasVotedNames = [];
        gs.hasVotedNames.push(player.name);

        const voteType = isWerewolfPhase ? 'werewolf' : 'village';
        await saveVoteToDB(roomId, player.name, target, voteType);

        // Prüfen ob alle abgestimmt haben
        const eligible = isWerewolfPhase
            ? gs.players.filter(p => p.role === 'werewolf' && p.alive)
            : gs.players.filter(p => p.alive);

        const allVoted = eligible.every(p => voteMap[p.name]);

        if (allVoted) {
            if (isWerewolfPhase) {
                await resolveWerewolfPhase(roomId);
            } else {
                await resolveVotingPhase(roomId);
            }
        } else {
            broadcastGameState(roomId); // Nur hasVotedNames sichtbar, Ziele versteckt
            saveRoomToDB(roomId);
        }
    });

    // Hexen-Aktion
    socket.on('witchAction', (roomId, { heal, poisonTarget }) => {
        if (!rooms[roomId]) return;
        const gs = rooms[roomId].gameState;
        if (gs.phase !== 'witch') return;

        const witch = gs.players.find(p => p.socketId === socket.id && p.role === 'witch');
        if (!witch) return;

        clearCountdown(roomId);

        if (heal && !gs.witchHealUsed && gs.nightVictim) {
            gs.nightVictim = null;
            gs.witchHealUsed = true;
        }

        if (poisonTarget && !gs.witchPoisonUsed) {
            const target = gs.players.find(p => p.name === poisonTarget && p.alive);
            if (target) {
                // Gift wird erst bei Tagesanbruch angewendet (in applyNightResults)
                gs.witchPoisonVictim = poisonTarget;
                gs.witchPoisonUsed = true;
            }
        }

        const newPhase = advanceFromWitch(roomId);
        broadcastGameState(roomId);
        saveRoomToDB(roomId);

        if (!gs.gameOver && newPhase === 'seer') {
            startCountdown(roomId, 90, () => seerTimeout(roomId));
        }
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

        clearCountdown(roomId);

        socket.emit('seerResult', { player: target, role: targetPlayer.role });

        applyNightResults(roomId);
        broadcastGameState(roomId);
        saveRoomToDB(roomId);
    });

    // Amor-Aktion: Liebespaar wählen
    socket.on('amorAction', (roomId, player1, player2) => {
        if (!rooms[roomId]) return;
        const gs = rooms[roomId].gameState;
        if (gs.phase !== 'amor') return;

        const amor = gs.players.find(p => p.socketId === socket.id && p.role === 'amor');
        if (!amor) return;

        // Amor darf sich nicht selbst ins Paar wählen
        if (player1 === amor.name || player2 === amor.name) return;
        if (player1 === player2) return;

        const p1 = gs.players.find(p => p.name === player1 && p.alive);
        const p2 = gs.players.find(p => p.name === player2 && p.alive);
        if (!p1 || !p2) return;

        clearCountdown(roomId);

        gs.loverNames = [player1, player2];

        // Verliebte privat benachrichtigen
        [p1, p2].forEach(lover => {
            const partnerName = lover.name === player1 ? player2 : player1;
            if (lover.socketId) {
                io.to(lover.socketId).emit('loverInfo', { partnerName });
            }
        });

        // Kurze Benachrichtigungs-Phase
        gs.phase = 'amor_notify';
        gs.announcement = '💘 Das Liebespaar wird benachrichtigt...';
        broadcastGameState(roomId);
        saveRoomToDB(roomId);
        startCountdown(roomId, 15, () => amorNotifyTimeout(roomId));
    });

    // Jäger-Rache: nach dem Tod ein Opfer wählen
    socket.on('hunterRevenge', (roomId, target) => {
        if (!rooms[roomId]) return;
        const gs = rooms[roomId].gameState;
        if (gs.phase !== 'hunter_revenge') return;

        const hunter = gs.players.find(p => p.socketId === socket.id && p.role === 'hunter');
        if (!hunter || hunter.alive) return; // Jäger muss tot sein

        clearCountdown(roomId);
        gs.hunterRevengeUsed = true;

        if (target) {
            const targetPlayer = gs.players.find(p => p.name === target && p.alive);
            if (targetPlayer) {
                const targetRole = targetPlayer.role;
                killPlayer(roomId, target);
                systemChat(roomId, `🎯 ${hunter.name} hat ${target} (${roleText(targetRole)}) mit in den Tod gerissen!`);
                checkGameOver(roomId);
            }
        }

        if (gs.gameOver || gs.phase === 'game_over_results') {
            broadcastGameState(roomId);
            saveRoomToDB(roomId);
            return;
        }

        proceedAfterHunterRevenge(roomId);
    });

    socket.on('returnToLobby', (roomId) => {
        if (!rooms[roomId]) return;
        if (!rooms[roomId].gameState.gameOver) return;

        clearCountdown(roomId);
        rooms[roomId].chatHistory = [];

        const gs = rooms[roomId].gameState;
        gs.phase             = 'lobby';
        gs.gameOver          = false;
        gs.round             = 0;
        gs.currentVoters     = [];
        gs.currentVoterIndex = 0;
        gs.votes             = {};
        gs.werewolfVotes     = {};
        gs.hasVotedNames     = [];
        gs.isWerewolfVoting  = false;
        gs.votingRound       = 1;
        gs.isFirstDay        = false;
        gs.afterNight        = false;
        gs.killedInNight     = null;
        gs.votingResult      = null;
        gs.announcement      = null;
        gs.witchHealUsed      = false;
        gs.witchPoisonUsed    = false;
        gs.nightVictim        = null;
        gs.witchPoisonVictim  = null;
        gs.loverNames         = [];
        gs.hunterRevengeUsed  = false;
        gs.afterHunterRevenge = null;
        gs.countdownEnd       = null;
        gs.countdownDuration  = 0;
        gs.dayPhaseStart      = null;
        gs.players.forEach(p => { p.role = null; p.alive = true; });

        broadcastGameState(roomId);
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

        if (rooms[roomId].players.length === 0) {
            clearCountdown(roomId);
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

        gs.players
            .filter(p => p.role === 'werewolf' && p.socketId)
            .forEach(wolf => io.to(wolf.socketId).emit('werewolfChat', msg));
    });

    socket.on('chatMessage', (roomId, message) => {
        if (!rooms[roomId]) return;
        const phase = rooms[roomId].gameState.phase;
        if (phase !== 'day' && phase !== 'voting' && phase !== 'game_over_results') return;

        const player = rooms[roomId].gameState.players.find(p => p.socketId === socket.id);
        if (!player) return;

        const msg = { name: player.name, message: message.slice(0, 300), system: false };
        if (!rooms[roomId].chatHistory) rooms[roomId].chatHistory = [];
        rooms[roomId].chatHistory.push(msg);
        if (rooms[roomId].chatHistory.length > 100) rooms[roomId].chatHistory.shift();
        io.to(roomId).emit('chatMessage', msg);
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
