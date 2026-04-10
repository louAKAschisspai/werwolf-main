const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

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

// --- Verbundene Clients verwalten ---
const rooms = {}; // { "room-id": { players: [], gameState: {} } }

// --- Hilfsfunktionen ---
function assignRoles(roomId) {
    const room = rooms[roomId];
    // Shuffle Spieler und ordne Rollen zu
    const shuffled = [...room.gameState.players].sort(() => Math.random() - 0.5);
    for (let i = 0; i < room.gameState.numWerewolves; i++) {
        shuffled[i].role = "werewolf";
    }
    for (let i = room.gameState.numWerewolves; i < shuffled.length; i++) {
        shuffled[i].role = "villager";
    }
    
    // Sortiere nach Join-Reihenfolge (neuste oben = absteigend)
    room.gameState.players = shuffled.sort((a, b) => (b.joinOrder || 0) - (a.joinOrder || 0));
}

function shufflePlayers(roomId) {
    const room = rooms[roomId];
    // Shuffle Spieler in der Lobby (ohne Rollen zu ändern)
    room.gameState.players = [...room.gameState.players].sort(() => Math.random() - 0.5);
}

function nextPhase(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.gameState.gameOver) return;

    if (room.gameState.phase === "lobby") {
        room.gameState.phase = "day";
        room.gameState.isFirstDay = true;
    } else if (room.gameState.phase === "night") {
        if (room.gameState.currentVoterIndex >= room.gameState.currentVoters.length) {
            const phaseComplete = resolveWerewolfVotes(roomId);  // 👈 Rückgabewert prüfen
            if (phaseComplete) {  // 👈 Nur wenn true → Phase wechseln
                room.gameState.phase = "day";
                room.gameState.afterNight = true;
            }
        }
    } else if (room.gameState.phase === "day") {
        if (room.gameState.isFirstDay) {
            room.gameState.isFirstDay = false;
            room.gameState.phase = "night";
            room.gameState.isWerewolfVoting = true;
            room.gameState.currentVoters = room.gameState.players.filter(p => p.role === "werewolf" && p.alive);
            room.gameState.currentVoterIndex = 0;
            room.gameState.werewolfVotes = {};
            room.gameState.votingRound = 1;
        } else if (room.gameState.afterNight) {
            room.gameState.afterNight = false;
            room.gameState.phase = "voting";
            room.gameState.isWerewolfVoting = false;
            room.gameState.currentVoters = room.gameState.players.filter(p => p.alive);
            room.gameState.currentVoterIndex = 0;
            room.gameState.votes = {};
        }
    } else if (room.gameState.phase === "voting") {
        if (room.gameState.currentVoterIndex >= room.gameState.currentVoters.length) {
            resolveVotes(roomId);
            room.gameState.phase = "night";
            room.gameState.round++;
            room.gameState.votes = {};
            room.gameState.werewolfVotes = {};
            room.gameState.votingResult = null;
            room.gameState.isWerewolfVoting = true;
            room.gameState.currentVoters = room.gameState.players.filter(p => p.role === "werewolf" && p.alive);
            room.gameState.currentVoterIndex = 0;
            room.gameState.werewolfVotes = {};
            room.gameState.votingRound = 1;
            room.gameState.afterNight = false;
        }
    }

    checkGameOver(roomId);
    io.to(roomId).emit('gameStateUpdated', { gameState: room.gameState });
}

function resolveWerewolfVotes(roomId) {
    const room = rooms[roomId];
    const counts = {};
    Object.values(room.gameState.werewolfVotes).forEach(target => {
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

    if (ties.length === 1 && killedPlayer && killedPlayer !== "Niemanden") {
        killPlayer(roomId, killedPlayer);
        room.gameState.killedInNight = killedPlayer;
        return true;  // 👈 Phase kann wechseln
    } else if (ties.length === 1 && killedPlayer === "Niemanden") {
        room.gameState.killedInNight = "Niemand";
        return true;  // 👈 Phase kann wechseln
    } else if (room.gameState.votingRound === 1) {
        // Gleichstand in Runde 1 → Runde 2
        room.gameState.votingRound = 2;
        room.gameState.werewolfVotes = {};
        room.gameState.currentVoterIndex = 0;
        room.gameState.announcement = "Gleichstand! Werwölfe stimmen erneut ab.";
        io.to(roomId).emit('gameStateUpdated', { gameState: room.gameState });
        return false;  // 👈 Phase wechselt NICHT!
    } else {
        // Immer noch Gleichstand in Runde 2 → niemand getötet
        room.gameState.killedInNight = "Niemand";
        return true;  // 👈 Phase kann wechseln
    }
}

function resolveVotes(roomId) {
    const room = rooms[roomId];
    const counts = {};

    Object.values(room.gameState.votes).forEach(target => {
        if (target !== "Niemanden") {
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
        killPlayer(roomId, killedPlayer);
        room.gameState.votingResult = killedPlayer;
        room.gameState.announcement = `${killedPlayer} wurde getötet!`;
    } else {
        room.gameState.votingResult = "Niemand (Gleichstand)";
        room.gameState.announcement = "Gleichstand! Niemand wird getötet.";
    }

    checkGameOver(roomId);
}

function killPlayer(roomId, name) {
    const room = rooms[roomId];
    const player = room.gameState.players.find(p => p.name === name);

    if (player && player.alive) {
        player.alive = false;
        checkGameOver(roomId);
    }
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    const wolves = room.gameState.players.filter(p => p.role === "werewolf" && p.alive).length;
    const villagers = room.gameState.players.filter(p => p.role === "villager" && p.alive).length;

    if (wolves === 0) {
        room.gameState.phase = "game_over";
        room.gameState.gameOver = true;
        room.gameState.announcement = "🎉 Dorfbewohner gewinnen!";
    } else if (wolves >= villagers) {
        room.gameState.phase = "game_over";
        room.gameState.gameOver = true;
        room.gameState.announcement = "🐺 Werwölfe gewinnen!";
    }
}

io.on('connection', (socket) => {
    console.log('Ein Client verbunden:', socket.id);

    // Client tritt einem Raum bei
    socket.on('joinRoom', (roomId, playerName) => {
        socket.join(roomId);
        console.log(`${playerName} tritt Raum ${roomId} bei`);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                gameState: {
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
                    votingResult: null
                }
            };
        }

        // Spieler zur Liste hinzufügen mit Join-Reihenfolge
        const player = { id: socket.id, name: playerName, socketId: socket.id };
        rooms[roomId].players.push(player);
        const joinOrder = rooms[roomId].gameState.players.length; // Aktuelle Position = Join Order
        rooms[roomId].gameState.players.push({ name: playerName, role: null, alive: true, socketId: socket.id, joinOrder: joinOrder });

        // Alle Clients im Raum informieren
        io.to(roomId).emit('playerJoined', {
            players: rooms[roomId].gameState.players,
            message: `${playerName} ist beigetreten`
        });

        console.log(`Spieler im Raum ${roomId}:`, rooms[roomId].gameState.players.length);
    });

    // Client verlässt
    socket.on('disconnect', () => {
        console.log('Ein Client getrennt:', socket.id);
        
        for (let roomId in rooms) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.socketId !== socket.id);
            rooms[roomId].gameState.players = rooms[roomId].gameState.players.filter(p => p.socketId !== socket.id);
            io.to(roomId).emit('playerLeft', {
                players: rooms[roomId].gameState.players
            });
            
            if (rooms[roomId].players.length === 0) {
                delete rooms[roomId];
            }
        }
    });

    // Spiel starten
    socket.on('startGame', (roomId, numWerewolves) => {
        if (rooms[roomId]) {
            rooms[roomId].gameState.numWerewolves = numWerewolves;
            assignRoles(roomId);
            rooms[roomId].gameState.phase = "day";
            rooms[roomId].gameState.isFirstDay = true;
            rooms[roomId].gameState.round = 1;
            rooms[roomId].gameState.currentVoters = [];
            rooms[roomId].gameState.currentVoterIndex = 0;
            io.to(roomId).emit('gameStateUpdated', { gameState: rooms[roomId].gameState });
        }
    });

    // Nächste Phase
    socket.on('nextPhase', (roomId) => {
        if (rooms[roomId]) {
            nextPhase(roomId);
        }
    });

    // Player Vote
    socket.on('playerVote', (roomId, target) => {
        if (rooms[roomId]) {
            const room = rooms[roomId];
            const voter = room.gameState.currentVoters[room.gameState.currentVoterIndex];
            
            if (room.gameState.isWerewolfVoting) {
                room.gameState.werewolfVotes[voter.name] = target;
            } else {
                room.gameState.votes[voter.name] = target;
            }
            
            room.gameState.currentVoterIndex++;
            io.to(roomId).emit('gameStateUpdated', { gameState: room.gameState });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server läuft auf http://localhost:${PORT}`);
});