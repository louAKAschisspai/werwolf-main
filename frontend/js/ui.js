// Lokaler Zustand für Hexen-Aktion (wird durch witchInfo-Event zurückgesetzt)
let _witchHealToggled   = false;
let _witchPoisonSelected = null;

function updateUI() {
    if (!socket || !currentRoomId) {
        show('joinRoom');
    } else if (gameState.gameOver) {
        show('endScreen');
        renderEndScreen();
    } else if (gameState.phase === 'lobby') {
        show('lobby');
        renderLobby();
    } else {
        show('game');
        renderGameHeader();
        renderPlayers();
        renderActions();
        updateWerewolfChatVisibility();
        updateChatVisibility();
    }
}

function show(section) {
    ['joinRoom', 'lobby', 'game', 'endScreen'].forEach(id => {
        document.getElementById(id).style.display = (id === section) ? 'block' : 'none';
    });
}

function amILeader() {
    return gameState.leaderName && gameState.leaderName === currentPlayerName;
}

function myRole() {
    const me = gameState.players.find(p => p.name === currentPlayerName);
    return me ? me.role : null;
}


// ---------------------------------------------------------------
// End Screen
// ---------------------------------------------------------------
function renderEndScreen() {
    const isWerewolfWin = gameState.announcement && gameState.announcement.includes('Werwölfe');
    const isVillageWin  = gameState.announcement && gameState.announcement.includes('Dorfbewohner');

    document.getElementById('endIcon').textContent  = isWerewolfWin ? '🐺' : isVillageWin ? '🎉' : '🏁';
    document.getElementById('endTitle').textContent = isWerewolfWin ? 'Werwölfe gewinnen!'
                                                    : isVillageWin  ? 'Dorfbewohner gewinnen!'
                                                    : 'Spiel beendet';

    const revealBox = document.getElementById('endRoleReveal');
    revealBox.innerHTML = '';

    if (!gameState.players || gameState.players.length === 0) return;

    const wolves    = gameState.players.filter(p => p.role === 'werewolf');
    // Village team: everyone who isn't a werewolf
    const villagers = gameState.players.filter(p => p.role !== 'werewolf');
    const winners   = isWerewolfWin ? wolves : isVillageWin ? villagers : [];

    // Gewinner-Block
    if (winners.length > 0) {
        const winnerSection = document.createElement('div');
        winnerSection.className = 'mb-4';

        const winnerLabel = document.createElement('p');
        winnerLabel.className = 'text-muted small mb-2 text-uppercase fw-semibold';
        winnerLabel.textContent = isWerewolfWin ? '🏆 Gewinner — Die Werwölfe' : '🏆 Gewinner — Das Dorf';
        winnerSection.appendChild(winnerLabel);

        const winnerList = document.createElement('div');
        winnerList.className = 'd-flex flex-wrap gap-2 justify-content-center';
        winners.forEach(p => {
            const chip = document.createElement('span');
            chip.className = 'badge px-3 py-2 fs-6 ' + (isWerewolfWin ? 'bg-danger' : 'bg-success');
            const crown = p.name === gameState.leaderName ? '👑 ' : '';
            chip.textContent = crown + p.name;
            winnerList.appendChild(chip);
        });
        winnerSection.appendChild(winnerList);
        revealBox.appendChild(winnerSection);
    }

    const hr = document.createElement('hr');
    hr.className = 'border-secondary my-3';
    revealBox.appendChild(hr);

    const allLabel = document.createElement('p');
    allLabel.className = 'text-muted small mb-2 text-uppercase fw-semibold';
    allLabel.textContent = 'Alle Rollen';
    revealBox.appendChild(allLabel);

    const allList = document.createElement('div');
    allList.className = 'd-flex flex-wrap gap-2 justify-content-center';
    gameState.players.forEach(p => {
        const chip = document.createElement('span');
        const roleLabel = roleDisplayName(p.role);
        const roleClass = roleBadgeClass(p.role);
        chip.className = 'badge px-2 py-1 ' + roleClass;
        const crown = p.name === gameState.leaderName ? '👑 ' : '';
        chip.textContent = crown + p.name + ' — ' + roleLabel;
        allList.appendChild(chip);
    });
    revealBox.appendChild(allList);
}


// ---------------------------------------------------------------
// Game Header (Phase, Runde, Ankündigung, aktueller Voter)
// ---------------------------------------------------------------
function renderGameHeader() {
    const phaseEl = document.getElementById('phase');
    const roundEl = document.getElementById('round');

    const isNightLike = (gameState.phase === 'night' || gameState.phase === 'witch' || gameState.phase === 'seer');

    if (gameState.gameOver) {
        phaseEl.textContent = '☠️ Spiel beendet';
        phaseEl.className = 'badge fs-6 phase-badge gameover-phase px-3 py-2';
    } else if (isNightLike) {
        phaseEl.textContent = '🌙 Nacht';
        phaseEl.className = 'badge fs-6 phase-badge night-phase px-3 py-2';
    } else {
        phaseEl.textContent = '☀️ Tag';
        phaseEl.className = 'badge fs-6 phase-badge day-phase px-3 py-2';
    }

    roundEl.textContent = 'Runde ' + gameState.round;

    // Ankündigung
    const announcementBox = document.getElementById('announcementBox');
    const announcementText = document.getElementById('announcement');
    if (gameState.announcement) {
        announcementText.textContent = gameState.announcement;
        announcementBox.classList.remove('d-none');
    } else {
        announcementBox.classList.add('d-none');
    }

    // Aktueller Voter (nur in Nacht/Voting-Phase)
    const voterBox = document.getElementById('currentVoterBox');
    const voterEl = document.getElementById('currentVoter');
    const amIWolf = gameState.players.find(p => p.name === currentPlayerName && p.role === 'werewolf');

    if ((gameState.phase === 'night' || gameState.phase === 'voting') &&
        gameState.currentVoterIndex < gameState.currentVoters.length) {
        const voter = gameState.currentVoters[gameState.currentVoterIndex];
        if (gameState.phase === 'night' && gameState.isWerewolfVoting) {
            if (amIWolf) {
                voterEl.innerHTML = '🐺 Wer ist dran: <strong>' + voter.name + '</strong>';
            } else {
                voterEl.textContent = '🌙 Werwölfe stimmen ab...';
            }
        } else {
            voterEl.innerHTML = 'Wer ist dran: <strong>' + voter.name + '</strong>';
        }
        voterBox.classList.remove('d-none');
    } else {
        voterBox.classList.add('d-none');
    }
}


// ---------------------------------------------------------------
// Spieler anzeigen
// ---------------------------------------------------------------
function renderPlayers() {
    const container = document.getElementById('players');
    container.innerHTML = '';
    const myName = currentPlayerName;
    const role   = myRole();
    const amIWolf = role === 'werewolf';

    gameState.players.forEach(player => {
        const col = document.createElement('div');
        col.className = 'col-6 col-sm-4';

        const card = document.createElement('div');
        card.className = 'player-card' + (player.alive ? '' : ' dead');

        // Icon
        const icon = document.createElement('span');
        if (!player.alive) {
            icon.textContent = '💀';
        } else if (player.name === myName) {
            if (role === 'werewolf')    icon.textContent = '🐺';
            else if (role === 'witch')  icon.textContent = '🧙';
            else if (role === 'seer')   icon.textContent = '🔮';
            else                        icon.textContent = '👤';
        } else if (amIWolf && player.role === 'werewolf') {
            icon.textContent = '🐺';
        } else {
            icon.textContent = '🧑';
        }

        // Name (mit Krone für den Leiter)
        const nameEl = document.createElement('span');
        nameEl.className = 'player-name';
        nameEl.textContent = (player.name === gameState.leaderName ? '👑 ' : '') + player.name;

        // Rollen-Badge
        const badge = document.createElement('span');
        badge.className = 'role-badge';
        if (!player.alive) {
            // Rolle aufdecken sobald der Spieler tot ist
            badge.textContent = '💀 ' + roleShortName(player.role);
            badge.classList.add(roleBadgeClass(player.role));
        } else if (player.name === myName) {
            badge.textContent = roleDisplayName(role);
            badge.classList.add(roleBadgeClass(role));
        } else if (amIWolf && player.role === 'werewolf') {
            badge.textContent = 'Werwolf';
            badge.classList.add('role-werewolf');
        } else {
            badge.textContent = '?';
            badge.classList.add('role-unknown');
        }

        card.appendChild(icon);
        card.appendChild(nameEl);
        card.appendChild(badge);
        col.appendChild(card);
        container.appendChild(col);
    });
}


// ---------------------------------------------------------------
// Aktionen anzeigen
// ---------------------------------------------------------------
function renderActions() {
    const container = document.getElementById('actions');
    container.innerHTML = '';

    if (gameState.gameOver) {
        container.innerHTML = '<p class="text-center fs-5 mb-0">Das Spiel ist vorbei!</p>';
        return;
    }

    if (gameState.phase === 'lobby') return;

    if (gameState.phase === 'witch') {
        renderWitchActions(container);
        return;
    }

    if (gameState.phase === 'seer') {
        renderSeerActions(container);
        return;
    }

    if (gameState.phase === 'day') {
        const msg = gameState.isFirstDay
            ? '<p>Alle schlafen noch. Der Leiter startet die erste Runde.</p>'
            : '<p>Tag-Phase – Die Dorfbewohner beraten sich. Nach der Abstimmung geht es weiter.</p>';
        container.innerHTML = msg;

        // Seherin: letzte Inspektion anzeigen
        if (myRole() === 'seer' && seerRevealResult) {
            const info = document.createElement('div');
            info.className = 'alert alert-info py-2 mb-2';
            info.innerHTML = `🔮 Deine letzte Inspektion: <strong>${escapeHtml(seerRevealResult.player)}</strong> ist ein <strong>${roleDisplayName(seerRevealResult.role)}</strong>`;
            container.insertBefore(info, container.firstChild);
        }

        if (amILeader()) container.appendChild(makeNextPhaseBtn());
        return;
    }

    // Alle Spieler haben abgestimmt
    if (gameState.currentVoterIndex >= gameState.currentVoters.length) {
        container.innerHTML = '<p>Alle haben abgestimmt.</p>';
        if (amILeader()) container.appendChild(makeNextPhaseBtn());
        return;
    }

    const voter = gameState.currentVoters[gameState.currentVoterIndex];
    const amIWolf = gameState.players.find(p => p.name === currentPlayerName && p.role === 'werewolf');

    if (voter && voter.name === currentPlayerName) {
        const label = document.createElement('p');
        label.className = 'fw-semibold mb-2';
        label.textContent = gameState.isWerewolfVoting
            ? '🐺 Wen wollt ihr fressen?'
            : '🗳️ Wen verdächtigst du?';
        container.appendChild(label);

        const grid = document.createElement('div');
        grid.className = 'd-flex flex-wrap gap-2';

        let targets = [];
        if (gameState.isWerewolfVoting) {
            targets = gameState.players.filter(p => p.alive && p.role !== 'werewolf').map(p => p.name);
        } else {
            targets = gameState.players.filter(p => p.alive).map(p => p.name);
        }
        targets.push('Niemanden');

        targets.forEach(target => {
            const btn = document.createElement('button');
            btn.className = target === 'Niemanden'
                ? 'btn btn-outline-secondary vote-btn'
                : 'btn btn-outline-danger vote-btn';
            btn.textContent = target;
            btn.onclick = () => sendVote(target);
            grid.appendChild(btn);
        });

        container.appendChild(grid);
    } else {
        const waiting = document.createElement('p');
        waiting.className = 'text-muted mb-0';
        if (gameState.phase === 'night' && gameState.isWerewolfVoting) {
            waiting.textContent = amIWolf
                ? '🐺 Warten auf ' + (voter ? voter.name : 'Spieler') + '...'
                : '🌙 Werwölfe stimmen ab...';
        } else {
            waiting.textContent = '⏳ Warten auf ' + (voter ? voter.name : 'Spieler') + '...';
        }
        container.appendChild(waiting);
    }
}


// ---------------------------------------------------------------
// Hexen-Aktionen
// ---------------------------------------------------------------
function renderWitchActions(container) {
    const iAmWitch = myRole() === 'witch';

    if (!iAmWitch) {
        const msg = document.createElement('p');
        msg.className = 'text-muted mb-0';
        msg.textContent = '🧙 Die Hexe entscheidet...';
        container.appendChild(msg);
        if (amILeader()) {
            const skip = makeSkipBtn();
            container.appendChild(skip);
        }
        return;
    }

    // --- Ich bin die Hexe ---
    const title = document.createElement('p');
    title.className = 'fw-semibold mb-3';
    title.textContent = '🧙 Du bist die Hexe! Entscheide deine Aktionen:';
    container.appendChild(title);

    // Info: Opfer der Werwölfe
    const victimInfo = document.createElement('div');
    victimInfo.className = 'alert alert-info py-2 mb-3';
    if (witchNightVictim) {
        victimInfo.innerHTML = `🌙 Die Werwölfe wählen <strong>${escapeHtml(witchNightVictim)}</strong>.`;
    } else {
        victimInfo.textContent = '🌙 Die Werwölfe wählen niemanden.';
    }
    container.appendChild(victimInfo);

    // --- Heiltrank ---
    if (!gameState.witchHealUsed && witchNightVictim) {
        const healSection = document.createElement('div');
        healSection.className = 'mb-3';

        const healLabel = document.createElement('p');
        healLabel.className = 'fw-semibold mb-1';
        healLabel.innerHTML = '💊 Heiltrank <span class="badge bg-success ms-1">1× verfügbar</span>';
        healSection.appendChild(healLabel);

        const healBtn = document.createElement('button');
        healBtn.className = 'btn ' + (_witchHealToggled ? 'btn-success' : 'btn-outline-success') + ' vote-btn';
        healBtn.innerHTML = _witchHealToggled
            ? `✅ ${escapeHtml(witchNightVictim)} retten (ausgewählt)`
            : `💊 ${escapeHtml(witchNightVictim)} retten`;
        healBtn.onclick = () => {
            _witchHealToggled = !_witchHealToggled;
            renderActions(); // re-render only actions
        };
        healSection.appendChild(healBtn);
        container.appendChild(healSection);
    } else if (gameState.witchHealUsed) {
        const used = document.createElement('p');
        used.className = 'text-muted small mb-3';
        used.textContent = '💊 Heiltrank bereits verbraucht.';
        container.appendChild(used);
    }

    // --- Gifttrank ---
    if (!gameState.witchPoisonUsed) {
        const poisonSection = document.createElement('div');
        poisonSection.className = 'mb-3';

        const poisonLabel = document.createElement('p');
        poisonLabel.className = 'fw-semibold mb-1';
        poisonLabel.innerHTML = '☠️ Gifttrank <span class="badge bg-danger ms-1">1× verfügbar</span>';
        poisonSection.appendChild(poisonLabel);

        const poisonGrid = document.createElement('div');
        poisonGrid.className = 'd-flex flex-wrap gap-2';

        const targets = gameState.players.filter(p => p.alive && p.name !== currentPlayerName);
        targets.forEach(p => {
            const btn = document.createElement('button');
            const selected = _witchPoisonSelected === p.name;
            btn.className = 'btn ' + (selected ? 'btn-danger' : 'btn-outline-danger') + ' vote-btn btn-sm';
            btn.textContent = selected ? `☠️ ${p.name} (ausgewählt)` : p.name;
            btn.onclick = () => {
                _witchPoisonSelected = selected ? null : p.name;
                renderActions();
            };
            poisonGrid.appendChild(btn);
        });

        poisonSection.appendChild(poisonGrid);
        container.appendChild(poisonSection);
    } else {
        const used = document.createElement('p');
        used.className = 'text-muted small mb-3';
        used.textContent = '☠️ Gifttrank bereits verbraucht.';
        container.appendChild(used);
    }

    // --- Bestätigen-Button ---
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary mt-1';
    confirmBtn.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i> Aktion bestätigen';
    confirmBtn.onclick = () => {
        sendWitchAction(_witchHealToggled, _witchPoisonSelected);
        _witchHealToggled   = false;
        _witchPoisonSelected = null;
    };
    container.appendChild(confirmBtn);
}


// ---------------------------------------------------------------
// Seherinnen-Aktionen
// ---------------------------------------------------------------
function renderSeerActions(container) {
    const iAmSeer = myRole() === 'seer';

    if (!iAmSeer) {
        const msg = document.createElement('p');
        msg.className = 'text-muted mb-0';
        msg.textContent = '🔮 Die Seherin schaut...';
        container.appendChild(msg);
        if (amILeader()) {
            container.appendChild(makeSkipBtn());
        }
        return;
    }

    // --- Ich bin die Seherin ---
    // Bereits inspiziertes Ergebnis zeigen (nach Klick, bevor Phase wechselt)
    if (seerRevealResult) {
        const result = document.createElement('div');
        result.className = 'alert alert-info py-2 mb-3';
        result.innerHTML = `🔮 <strong>${escapeHtml(seerRevealResult.player)}</strong> ist ein <strong>${roleDisplayName(seerRevealResult.role)}</strong>!`;
        container.appendChild(result);
        return;
    }

    const title = document.createElement('p');
    title.className = 'fw-semibold mb-2';
    title.textContent = '🔮 Du bist die Seherin! Wähle einen Spieler, um seine Rolle zu erfahren:';
    container.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'd-flex flex-wrap gap-2';

    const targets = gameState.players.filter(p => p.alive && p.name !== currentPlayerName);
    targets.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-outline-info vote-btn';
        btn.textContent = p.name;
        btn.onclick = () => sendSeerAction(p.name);
        grid.appendChild(btn);
    });

    container.appendChild(grid);
}


// ---------------------------------------------------------------
// Hilfsfunktionen: Nächste Phase & Überspringen
// ---------------------------------------------------------------
function makeNextPhaseBtn() {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary mt-2';
    btn.innerHTML = '<i class="bi bi-arrow-right-circle-fill me-1"></i> Nächste Phase';
    btn.onclick = nextPhaseServer;
    return btn;
}

function makeSkipBtn() {
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline-secondary btn-sm mt-2';
    btn.innerHTML = '<i class="bi bi-skip-forward-fill me-1"></i> Überspringen';
    btn.onclick = nextPhaseServer;
    return btn;
}


// ---------------------------------------------------------------
// Lobby rendern
// ---------------------------------------------------------------
function renderLobby() {
    const list = document.getElementById('playerList');
    list.innerHTML = '';

    if (gameState.players.length === 0) {
        list.innerHTML = '<p class="text-muted mb-0">Noch niemand im Raum...</p>';
    } else {
        gameState.players.forEach(player => {
            const item = document.createElement('div');
            item.className = 'lobby-player';
            const isLeader = player.name === gameState.leaderName;
            const crown = isLeader ? ' <span class="text-warning" title="Leiter">👑</span>' : '';
            item.innerHTML = '<span class="player-dot"></span>' + escapeHtml(player.name) + crown;
            list.appendChild(item);
        });
    }

    document.getElementById('roomInfo').textContent = 'Raum: ' + currentRoomId;

    const leaderCard    = document.getElementById('leaderSettingsCard');
    const readOnlyCard  = document.getElementById('settingsReadOnly');
    const startBtn      = document.getElementById('startGame');
    const leaderHint    = document.getElementById('lobbyLeaderHint');

    if (amILeader()) {
        leaderCard.classList.remove('d-none');
        readOnlyCard.classList.add('d-none');
        startBtn.classList.remove('d-none');
        leaderHint.classList.add('d-none');

        // Checkboxen synchronisieren (ohne Event-Loop)
        const witchCheck = document.getElementById('roleWitch');
        const seerCheck  = document.getElementById('roleSeer');
        if (witchCheck) witchCheck.checked = !!(gameState.activeRoles?.witch);
        if (seerCheck)  seerCheck.checked  = !!(gameState.activeRoles?.seer);
    } else {
        leaderCard.classList.add('d-none');
        readOnlyCard.classList.remove('d-none');
        document.getElementById('werewolfCountDisplay').textContent = gameState.numWerewolves ?? 1;

        // Sonderrollen anzeigen
        const rolesEl = document.getElementById('activeRolesDisplay');
        const active = [];
        if (gameState.activeRoles?.witch) active.push('🧙 Hexe');
        if (gameState.activeRoles?.seer)  active.push('🔮 Seherin');
        rolesEl.textContent = active.length
            ? 'Sonderrollen: ' + active.join(', ')
            : 'Keine Sonderrollen aktiv';

        startBtn.classList.add('d-none');
        leaderHint.classList.remove('d-none');
    }
}


// ---------------------------------------------------------------
// Werwolf-Chat
// ---------------------------------------------------------------
function updateWerewolfChatVisibility() {
    const section  = document.getElementById('werewolfChatSection');
    const input    = document.getElementById('werewolfChatInput');
    const sendBtn  = document.getElementById('werewolfChatSendBtn');
    const quickDiv = document.getElementById('werewolfQuickBtns');

    const amIWolf   = myRole() === 'werewolf';
    const isNight   = gameState.phase === 'night';
    const meAlive   = gameState.players.find(p => p.name === currentPlayerName)?.alive ?? false;

    // Nur während Nacht und nur für Werwölfe anzeigen
    if (!amIWolf || !isNight) {
        section.classList.add('d-none');
        return;
    }

    section.classList.remove('d-none');

    // Schreiben nur für lebende Wölfe
    const canWrite = meAlive;
    input.disabled  = !canWrite;
    sendBtn.disabled = !canWrite;
    input.placeholder = canWrite ? 'Nachricht an Werwölfe...' : '💀 Nur lebende Werwölfe können schreiben';

    // Schnellvorschläge: ein Button pro lebendem Nicht-Werwolf
    quickDiv.innerHTML = '';
    if (canWrite) {
        const targets = gameState.players.filter(p => p.alive && p.role !== 'werewolf');
        targets.forEach(p => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-outline-danger wolf-quick-btn';
            btn.textContent = `Lass uns ${p.name} wählen`;
            btn.onclick = () => {
                sendWerewolfChat(`Lass uns ${p.name} wählen`);
            };
            quickDiv.appendChild(btn);
        });
    }
}

function appendWerewolfMessage(name, message) {
    const box = document.getElementById('werewolfChatMessages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = '<span class="chat-name" style="color:#fca5a5">' + escapeHtml(name) + ':</span> ' + escapeHtml(message);
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------
// Chat
// ---------------------------------------------------------------
function updateChatVisibility() {
    document.getElementById('chatSection').classList.remove('d-none');
    const canChat = (gameState.phase === 'day' || gameState.phase === 'voting');
    const input   = document.getElementById('chatInput');
    const btn     = document.getElementById('chatSendBtn');
    input.disabled = !canChat;
    btn.disabled   = !canChat;
    input.placeholder = canChat
        ? 'Nachricht schreiben...'
        : '💤 Chat nur in Tag- und Voting-Phase';
}

function appendChatMessage(name, message, system = false) {
    const box = document.getElementById('chatMessages');
    if (!box) return;
    const div = document.createElement('div');
    if (system) {
        div.className = 'chat-msg chat-system';
        if (message.startsWith('🏁'))      div.dataset.type = 'end';
        else if (message.startsWith('⚖️')) div.dataset.type = 'vote';
        else if (message.startsWith('🌅')) div.dataset.type = 'kill';
        div.textContent = message;
    } else {
        div.className = 'chat-msg';
        div.innerHTML = '<span class="chat-name">' + escapeHtml(name) + ':</span> ' + escapeHtml(message);
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function clearChatMessages() {
    const box = document.getElementById('chatMessages');
    if (box) box.innerHTML = '';
}


// ---------------------------------------------------------------
// Rollen-Hilfsfunktionen
// ---------------------------------------------------------------
function roleDisplayName(role) {
    switch (role) {
        case 'werewolf': return '🐺 Werwolf';
        case 'witch':    return '🧙 Hexe';
        case 'seer':     return '🔮 Seherin';
        case 'villager': return '🧑 Dorfbewohner';
        default:         return role || '?';
    }
}

function roleShortName(role) {
    switch (role) {
        case 'werewolf': return 'Werwolf';
        case 'witch':    return 'Hexe';
        case 'seer':     return 'Seherin';
        case 'villager': return 'Dorfbewohner';
        default:         return role || '?';
    }
}

function roleBadgeClass(role) {
    switch (role) {
        case 'werewolf': return 'role-werewolf';
        case 'witch':    return 'role-witch';
        case 'seer':     return 'role-seer';
        case 'villager': return 'role-villager';
        default:         return 'role-unknown';
    }
}


// ---------------------------------------------------------------
// XSS-Schutz
// ---------------------------------------------------------------
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}


// ---------------------------------------------------------------
// Event Listener
// ---------------------------------------------------------------
document.getElementById('joinRoomBtn').addEventListener('click', () => {
    const roomId = document.getElementById('roomId').value.trim();
    const playerName = document.getElementById('playerName').value.trim();

    if (!roomId || !playerName) {
        alert('Bitte beide Felder ausfüllen!');
        return;
    }

    gameState.phase = 'lobby';
    joinRoom(roomId, playerName);
    updateUI();
});

document.getElementById('startGame').addEventListener('click', () => {
    const num = parseInt(document.getElementById('numWerewolves').value);
    if (gameState.players.length < 3) {
        alert('Mindestens 3 Spieler benötigt!');
        return;
    }
    if (num < 1 || num >= gameState.players.length) {
        alert('Ungültige Anzahl Werwölfe!');
        return;
    }
    startGame(num);
});

// Leiter-Einstellungen: sofort an alle senden wenn Leader etwas ändert
let _lobbySettingsTimer = null;
function emitLobbySettings() {
    clearTimeout(_lobbySettingsTimer);
    _lobbySettingsTimer = setTimeout(() => {
        const num = parseInt(document.getElementById('numWerewolves').value) || 1;
        const witch = document.getElementById('roleWitch')?.checked || false;
        const seer  = document.getElementById('roleSeer')?.checked  || false;
        sendLobbySettings(num, { witch, seer });
    }, 150); // kurzes Debounce
}

document.getElementById('numWerewolves').addEventListener('input', () => {
    if (amILeader()) emitLobbySettings();
});
document.getElementById('roleWitch').addEventListener('change', () => {
    if (amILeader()) emitLobbySettings();
});
document.getElementById('roleSeer').addEventListener('change', () => {
    if (amILeader()) emitLobbySettings();
});

// "In der Lobby bleiben"
document.getElementById('btnStayInLobby').addEventListener('click', () => {
    returnToLobby();
});

// "Zurück zum Startbildschirm"
document.getElementById('btnLeaveRoom').addEventListener('click', () => {
    leaveRoom();
    updateUI();
});

// Lobby verlassen
document.getElementById('leaveLobbyBtn').addEventListener('click', () => {
    leaveRoom();
    updateUI();
});

// Werwolf-Chat: Senden per Button
document.getElementById('werewolfChatSendBtn').addEventListener('click', () => {
    const input = document.getElementById('werewolfChatInput');
    sendWerewolfChat(input.value);
    input.value = '';
});

// Werwolf-Chat: Senden per Enter
document.getElementById('werewolfChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const input = document.getElementById('werewolfChatInput');
        sendWerewolfChat(input.value);
        input.value = '';
    }
});

// Chat: Senden per Button
document.getElementById('chatSendBtn').addEventListener('click', () => {
    const input = document.getElementById('chatInput');
    sendChat(input.value);
    input.value = '';
});

// Chat: Senden per Enter
document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const input = document.getElementById('chatInput');
        sendChat(input.value);
        input.value = '';
    }
});

// Initial render
updateUI();
