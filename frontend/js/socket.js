// --- Socket.io Verbindung ---
let socket = null;
let currentRoomId = null;
let currentPlayerName = null;  // 👈 Lokaler playerName statt localStorage

function initSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('Mit Server verbunden');
    });

    socket.on('playerJoined', (data) => {
        gameState.players = data.players.map(p => ({
            name: p.name,
            role: p.role,
            alive: p.alive
        }));
        if (gameState.phase !== "lobby") {
            gameState.phase = "lobby";
        }
        updateUI();
    });

    socket.on('playerLeft', (data) => {
        console.log('Spieler verlassen');
        gameState.players = data.players.map(p => ({
            name: p.name,
            role: p.role,
            alive: p.alive
        }));
        updateUI();
    });

    socket.on('gameStateUpdated', (data) => {
        Object.assign(gameState, data.gameState);
        updateUI();
    });

    socket.on('disconnect', () => {
        console.log('Von Server getrennt');
    });
}

function joinRoom(roomId, playerName) {
    if (!socket) initSocket();
    currentRoomId = roomId;
    currentPlayerName = playerName;
    socket.emit('joinRoom', roomId, playerName);
}

function startGame(numWerewolves) {
    if (!socket) {
        alert('Fehler: Nicht mit Server verbunden. Seite neu laden!');
        return;
    }
    
    if (!currentRoomId) {
        alert('Fehler: Raum-ID nicht gesetzt!');
        return;
    }
    
    socket.emit('startGame', currentRoomId, numWerewolves);
}

function nextPhaseServer() {
    if (socket && currentRoomId) {
        socket.emit('nextPhase', currentRoomId);
    }
}

function sendVote(target) {
    if (socket && currentRoomId) {
        socket.emit('playerVote', currentRoomId, target);
    }
}

// Socket am Anfang initialisieren
initSocket();
