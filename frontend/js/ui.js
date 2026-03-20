function updateUI() {
    if (gameState.phase === "lobby") {
        document.getElementById("lobby").style.display = "block";
        document.getElementById("game").style.display = "none";
        renderLobby();
    } else {
        document.getElementById("lobby").style.display = "none";
        document.getElementById("game").style.display = "block";

        document.getElementById("phase").innerText =
            gameState.gameOver
                ? "Spiel beendet"
                : "Phase: " + gameState.phase;

        document.getElementById("round").innerText =
            "Runde: " + gameState.round;

        let announcement = "";
        if (gameState.phase === "day" && gameState.isFirstDay) {
            const numPlayers = gameState.players.length;
            const numWolves = gameState.players.filter(p => p.role === "werewolf").length;
            announcement = `Es sind ${numPlayers} Spieler in der Runde, davon ${numWolves} Werwölfe.`;
        } else if (gameState.phase === "day" && gameState.killedInNight) {
            announcement = "In der Nacht wurde " + gameState.killedInNight + " getötet.";
        } else if (gameState.phase === "voting" && gameState.votingResult && gameState.currentVoterIndex >= gameState.currentVoters.length) {
            announcement = "Voting-Ergebnis: " + gameState.votingResult + " wurde getötet.";
        }
        document.getElementById("announcement").innerText = announcement;

        if (gameState.currentVoterIndex < gameState.currentVoters.length) {
            const voter = gameState.currentVoters[gameState.currentVoterIndex];
            document.getElementById("currentVoter").innerText = "Wer ist dran: " + voter.name;
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

    gameState.players.forEach(player => {

        const div = document.createElement("div");

        div.innerText =
            player.name + " (" + player.role + ")";

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

    if (gameState.phase === "day") {
        container.innerHTML = "<p>Alle schlafen. Klicke 'Nächste Phase' um zu voten.</p>";
        return;
    }

    if (gameState.currentVoterIndex >= gameState.currentVoters.length) {
        if (gameState.phase === "voting") {
            container.innerHTML = "<p>Voting beendet. Ergebnis oben. Klicke 'Nächste Phase'.</p>";
        } else {
            container.innerHTML = "<p>Alle haben abgestimmt. Klicke 'Nächste Phase'.</p>";
        }
        return;
    }

    const voter = gameState.currentVoters[gameState.currentVoterIndex];
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

        btn.onclick = () => {
            if (gameState.isWerewolfVoting) {
                voteWerewolf(target);
            } else {
                votePlayer(target);
            }
        };

        container.appendChild(btn);
    });
}


// --- Lobby rendern ---
function renderLobby() {
    const list = document.getElementById("playerList");
    list.innerHTML = "<h3>Hinzugefügte Spieler:</h3><ul>";
    gameState.players.forEach(player => {
        list.innerHTML += `<li>${player.name}</li>`;
    });
    list.innerHTML += "</ul>";
}

// --- Event Listener ---
document.getElementById("addPlayer").addEventListener("click", () => {
    const name = document.getElementById("playerName").value.trim();
    if (name && !gameState.players.find(p => p.name === name)) {
        gameState.players.push({ name, role: null, alive: true });
        document.getElementById("playerName").value = "";
        updateUI();
    } else {
        alert("Ungültiger oder doppelter Name!");
    }
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
    gameState.numWerewolves = num;
    assignRoles();
    gameState.phase = "day";
    updateUI();
});

// --- Button verbinden ---
document.getElementById("nextPhase")
    .addEventListener("click", nextPhase);


// Initial render
updateUI();