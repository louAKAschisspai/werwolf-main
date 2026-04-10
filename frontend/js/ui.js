function updateUI() {
    if (!socket || !currentRoomId) {
        // Noch nicht im Raum
        document.getElementById("joinRoom").style.display = "block";
        document.getElementById("lobby").style.display = "none";
        document.getElementById("game").style.display = "none";
    } else if (gameState.phase === "lobby") {
        document.getElementById("joinRoom").style.display = "none";
        document.getElementById("lobby").style.display = "block";
        document.getElementById("game").style.display = "none";
        renderLobby();
    } else {
        document.getElementById("joinRoom").style.display = "none";
        document.getElementById("lobby").style.display = "none";
        document.getElementById("game").style.display = "block";

        document.getElementById("phase").innerText =
            gameState.gameOver
                ? "Spiel beendet"
                : "Phase: " + gameState.phase;

        document.getElementById("round").innerText =
            "Runde: " + gameState.round;

        // Zeige die Ankündigung an, die vom Server kommt
        if (gameState.announcement) {
            document.getElementById("announcement").innerText = gameState.announcement;
        } else {
            document.getElementById("announcement").innerText = "";
        }

        // Zeige nur während Nacht-Phase (Werwolf-Abstimmung) für Werwölfe
        if (gameState.currentVoterIndex < gameState.currentVoters.length) {
            const voter = gameState.currentVoters[gameState.currentVoterIndex];
            const myName = currentPlayerName;
            const amIWolf = gameState.players.find(p => p.name === myName && p.role === "werewolf");
            
            if (gameState.phase === "night" && gameState.isWerewolfVoting) {
                // Nachts: Nur Werwölfe sehen wer dran ist
                if (amIWolf) {
                    document.getElementById("currentVoter").innerText = "🐺 Wer ist dran: " + voter.name;
                } else {
                    document.getElementById("currentVoter").innerText = "🌙 Werwölfe stimmen ab...";
                }
            } else {
                // Tagsüber: Normal anzeigen wer dran ist
                document.getElementById("currentVoter").innerText = "Wer ist dran: " + voter.name;
            }
        } else {
            document.getElementById("currentVoter").innerText = "";
        }

        renderPlayers();
        renderActions();
    }
}


// --- Spieler anzeigen ---
function renderPlayers() {

    const container = document.getElementById("players");
    container.innerHTML = "";
    const myName = currentPlayerName;
    const amIWolf = gameState.players.find(p => p.name === myName && p.role === "werewolf");

    gameState.players.forEach(player => {

        const div = document.createElement("div");
        let displayText = player.name;

        // Zeige Rolle nur:
        // 1. Für den eigenen Spieler
        // 2. Für andere Werwölfe (wenn man selbst Werwolf ist)
        if (player.name === myName) {
            // Eigener Spieler sieht immer seine Rolle
            displayText += " (" + (player.alive ? player.role : "KOPF AB") + ")";
        } else if (player.alive && amIWolf && player.role === "werewolf") {
            // Werwölfe sehen andere Werwölfe
            displayText += " (werewolf)";
        } else if (!player.alive) {
            // Tote Spieler zeigen "KOPF AB"
            displayText += " (KOPF AB)";
        } else {
            // Lebende Spieler (für die man nicht ihre Rolle sehen soll) werden ohne Rolle angezeigt
            displayText += " (?)";
        }

        div.innerText = displayText;

        if (!player.alive) {
            div.classList.add("dead");
        }

        container.appendChild(div);
    });
}


// --- Aktionen anzeigen ---
function renderActions() {

    const container = document.getElementById("actions");
    container.innerHTML = "";

    // 👇 Spiel beendet → keine Aktionen mehr
    if (gameState.gameOver) {
        container.innerHTML = "<h3>Spiel beendet</h3>";
        return;
    }

    if (gameState.phase === "lobby") {
        return;
    }

    if (gameState.phase === "day") {
        if (gameState.isFirstDay) {
            container.innerHTML = "<p>Alle schlafen. Alle ist dran: KLICKE 'Nächste Phase' zum Start.</p>";
            const btn = document.createElement("button");
            btn.innerText = "Nächste Phase";
            btn.onclick = nextPhaseServer;
            container.appendChild(btn);
        } else {
            container.innerHTML = "<p>Tag-Phase - Alle sind am Leben. Nach Abstimmung geht es weiter.</p>";
            const btn = document.createElement("button");
            btn.innerText = "Nächste Phase";
            btn.onclick = nextPhaseServer;
            container.appendChild(btn);
        }
        return;
    }

    if (gameState.currentVoterIndex >= gameState.currentVoters.length) {
        container.innerHTML = "<p>Alle haben abgestimmt. Klicke 'Nächste Phase'.</p>";
        const btn = document.createElement("button");
        btn.innerText = "Nächste Phase";
        btn.onclick = nextPhaseServer;
        container.appendChild(btn);
        return;
    }

    const voter = gameState.currentVoters[gameState.currentVoterIndex];
    const myName = currentPlayerName;
    const amIWolf = gameState.players.find(p => p.name === myName && p.role === "werewolf");
    
    // Nur der aktuelle Spieler sieht Abstimmungsbuttons
    if (voter && voter.name === myName) {
        let targets = [];

        if (gameState.isWerewolfVoting) {
            targets = gameState.players.filter(p => p.alive && p.role !== "werewolf").map(p => p.name);
            targets.push("Niemanden");
        } else {
            targets = gameState.players.filter(p => p.alive).map(p => p.name);
            targets.push("Niemanden");
        }

        targets.forEach(target => {
            const btn = document.createElement("button");
            btn.innerText = target;
            btn.onclick = () => sendVote(target);
            container.appendChild(btn);
        });
    } else {
        // Nachts: Nur Werwölfe sehen wer dran ist
        if (gameState.phase === "night" && gameState.isWerewolfVoting) {
            if (amIWolf) {
                container.innerHTML = `<p>🐺 Warten auf ${voter ? voter.name : "Spieler"} zum Abstimmen...</p>`;
            } else {
                container.innerHTML = "<p>🌙 Werwölfe stimmen ab...</p>";
            }
        } else {
            container.innerHTML = `<p>Warten auf ${voter ? voter.name : "Spieler"} zum Abstimmen...</p>`;
        }
    }
}


// --- Lobby rendern ---
function renderLobby() {
    const list = document.getElementById("playerList");
    list.innerHTML = "<h3>Spieler im Raum:</h3><ul>";
    gameState.players.forEach(player => {
        list.innerHTML += `<li>${player.name}</li>`;
    });
    list.innerHTML += "</ul>";
    
    document.getElementById("roomInfo").innerText = `Du bist im Raum: ${currentRoomId}`;
}

// --- Event Listener ---
document.getElementById("joinRoomBtn").addEventListener("click", () => {
    const roomId = document.getElementById("roomId").value.trim();
    const playerName = document.getElementById("playerName").value.trim();
    
    if (!roomId || !playerName) {
        alert("Bitte beide Felder ausfüllen!");
        return;
    }
    
    gameState.phase = "lobby";
    joinRoom(roomId, playerName);  // currentPlayerName wird in joinRoom gesetzt
    updateUI();
});

document.getElementById("startGame").addEventListener("click", () => {
    const num = parseInt(document.getElementById("numWerewolves").value);
    if (gameState.players.length < 3) {
        alert("Mindestens 3 Spieler benötigt!");
        return;
    }
    if (num < 1 || num >= gameState.players.length) {
        alert("Ungültige Anzahl Werwölfe!");
        return;
    }
    startGame(num);
});

// --- Button verbinden ---
if (document.getElementById("nextPhase")) {
    document.getElementById("nextPhase").addEventListener("click", nextPhaseServer);
}


// Initial render
updateUI();