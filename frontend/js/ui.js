// Lokaler Zustand für Hexen-Aktion
let _witchHealToggled    = false;
let _witchPoisonSelected = null;

// Lokaler Zustand für Amor-Aktion
let _amorSelected = [];

// Eigenes Abstimmungsziel (lokal, nicht aus gameState – Ziele werden serverseitig versteckt)
// var statt let → global zugänglich aus socket.js
var _myVoteTarget = null;

// Countdown-Intervall Handle
let _countdownInterval = null;

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

function amIAlive() {
    const me = gameState.players.find(p => p.name === currentPlayerName);
    return me ? me.alive : false;
}


// ---------------------------------------------------------------
// Countdown-Anzeige
// ---------------------------------------------------------------
function startCountdownDisplay() {
    if (_countdownInterval) return;
    _countdownInterval = setInterval(tickCountdown, 500);
}

function tickCountdown() {
    const widget   = document.getElementById('countdownWidget');
    const secEl    = document.getElementById('countdownSeconds');
    const barEl    = document.getElementById('countdownBar');
    const labelEl  = document.getElementById('countdownLabel');

    const endsAt   = gameState.countdownEnd;
    const duration = gameState.countdownDuration || 1;

    if (!endsAt || !widget) {
        if (widget) widget.classList.add('d-none');
        clearInterval(_countdownInterval);
        _countdownInterval = null;
        return;
    }

    const remaining = Math.ceil((endsAt - Date.now()) / 1000);
    const isUrgent  = remaining <= 10;

    if (remaining <= 0) {
        widget.classList.add('d-none');
        clearInterval(_countdownInterval);
        _countdownInterval = null;
        return;
    }

    widget.classList.remove('d-none');
    secEl.textContent = remaining + 's';
    secEl.className   = 'countdown-time' + (isUrgent ? ' urgent' : '');

    const pct = Math.max(0, Math.min(100, (remaining / duration) * 100));
    barEl.style.width = pct + '%';
    barEl.className   = 'countdown-bar-fill' + (isUrgent ? ' urgent' : '');

    // Label je nach Phase anpassen
    if (labelEl) {
        if (gameState.phase === 'day' && gameState.afterNight) {
            labelEl.textContent = 'Diskussion endet in';
        } else if (gameState.phase === 'witch' || gameState.phase === 'seer' ||
                   gameState.phase === 'amor'  || gameState.phase === 'amor_notify') {
            labelEl.textContent = 'Nächste Phase in';
        } else if (gameState.phase === 'result') {
            labelEl.textContent = 'Nacht beginnt in';
        } else if (gameState.phase === 'game_over_results') {
            labelEl.textContent = 'Spiel wird beendet in';
        } else if (gameState.phase === 'hunter_revenge') {
            labelEl.textContent = 'Jäger entscheidet in';
        } else {
            labelEl.textContent = 'Abstimmung endet in';
        }
    }

    // "Weiter"-Button für Game Over Results (kein Lockout, da Timer selbst nur 15s)
    const gameOverBtn = document.getElementById('gameOverNextPhaseBtn');
    if (gameOverBtn && gameState.phase === 'game_over_results') {
        gameOverBtn.disabled = false;
        gameOverBtn.innerHTML = '<i class="bi bi-trophy-fill me-1"></i> Ergebnis anzeigen';
    }

    // "Abstimmung starten"-Button für Leiter nach 15s freischalten
    const dayBtn = document.getElementById('dayNextPhaseBtn');
    if (dayBtn && gameState.phase === 'day' && gameState.afterNight) {
        const buttonActiveAt = endsAt - (duration - 15) * 1000;
        const isLocked = Date.now() < buttonActiveAt;
        dayBtn.disabled = isLocked;
        if (isLocked) {
            const lockSec = Math.ceil((buttonActiveAt - Date.now()) / 1000);
            dayBtn.innerHTML = `<i class="bi bi-lock-fill me-1"></i> Abstimmung in ${lockSec}s`;
        } else {
            dayBtn.innerHTML = '<i class="bi bi-arrow-right-circle-fill me-1"></i> Abstimmung starten';
        }
    }
}


// ---------------------------------------------------------------
// End Screen
// ---------------------------------------------------------------
function renderEndScreen() {
    const isWerewolfWin = gameState.announcement && gameState.announcement.includes('Werwölfe');
    const isVillageWin  = gameState.announcement && gameState.announcement.includes('Dorfbewohner');
    const isLoverWin    = gameState.announcement && gameState.announcement.includes('Liebespaar');

    document.getElementById('endIcon').textContent  = isWerewolfWin ? '🐺'
                                                    : isVillageWin  ? '🎉'
                                                    : isLoverWin    ? '💕'
                                                    : '🏁';
    document.getElementById('endTitle').textContent = isWerewolfWin ? 'Werwölfe gewinnen!'
                                                    : isVillageWin  ? 'Dorfbewohner gewinnen!'
                                                    : isLoverWin    ? 'Das Liebespaar gewinnt!'
                                                    : 'Spiel beendet';

    const revealBox = document.getElementById('endRoleReveal');
    revealBox.innerHTML = '';

    if (!gameState.players || gameState.players.length === 0) return;

    const loverNames = gameState.loverNames || [];
    const wolves    = gameState.players.filter(p => p.role === 'werewolf');
    const villagers = gameState.players.filter(p => p.role !== 'werewolf');
    const winners   = isLoverWin    ? gameState.players.filter(p => loverNames.includes(p.name))
                    : isWerewolfWin ? wolves
                    : isVillageWin  ? villagers
                    : [];

    if (winners.length > 0) {
        const winnerSection = document.createElement('div');
        winnerSection.className = 'mb-4';

        const winnerLabel = document.createElement('p');
        winnerLabel.className = 'text-muted small mb-2 text-uppercase fw-semibold';
        winnerLabel.textContent = isLoverWin    ? '🏆 Gewinner — Das Liebespaar'
                                : isWerewolfWin ? '🏆 Gewinner — Die Werwölfe'
                                : '🏆 Gewinner — Das Dorf';
        winnerSection.appendChild(winnerLabel);

        const winnerList = document.createElement('div');
        winnerList.className = 'd-flex flex-wrap gap-2 justify-content-center';
        winners.forEach(p => {
            const chip = document.createElement('span');
            chip.className = 'badge px-3 py-2 fs-6 ' + (isWerewolfWin ? 'bg-danger' : isLoverWin ? 'bg-warning text-dark' : 'bg-success');
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
// Game Header (Phase, Runde, Ankündigung)
// ---------------------------------------------------------------
function renderGameHeader() {
    const phaseEl = document.getElementById('phase');
    const roundEl = document.getElementById('round');

    const isNightLike = (gameState.phase === 'night' || gameState.phase === 'witch' ||
                         gameState.phase === 'seer'  || gameState.phase === 'amor' ||
                         gameState.phase === 'amor_notify');

    if (gameState.gameOver) {
        phaseEl.textContent = '☠️ Spiel beendet';
        phaseEl.className = 'badge fs-6 phase-badge gameover-phase px-3 py-2';
    } else if (gameState.phase === 'game_over_results') {
        phaseEl.textContent = '📋 Ergebnisse';
        phaseEl.className = 'badge fs-6 phase-badge gameover-phase px-3 py-2';
    } else if (isNightLike) {
        phaseEl.textContent = '🌙 Nacht';
        phaseEl.className = 'badge fs-6 phase-badge night-phase px-3 py-2';
    } else if (gameState.phase === 'result' || gameState.phase === 'hunter_revenge') {
        phaseEl.textContent = '⚖️ Ergebnis';
        phaseEl.className = 'badge fs-6 phase-badge day-phase px-3 py-2';
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

    // currentVoterBox ausblenden (wird nicht mehr genutzt)
    document.getElementById('currentVoterBox').classList.add('d-none');

    // Countdown-Anzeige aktualisieren
    const widget = document.getElementById('countdownWidget');
    if (gameState.countdownEnd && gameState.countdownEnd > Date.now()) {
        widget.classList.remove('d-none');
        startCountdownDisplay();
    } else {
        widget.classList.add('d-none');
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

        const nameEl = document.createElement('span');
        nameEl.className = 'player-name';
        // Liebessymbol nur für die Verliebten selbst sichtbar
        const showHeart = loverPartnerName &&
            (player.name === currentPlayerName || player.name === loverPartnerName);
        nameEl.textContent = (player.name === gameState.leaderName ? '👑 ' : '') +
            player.name + (showHeart ? ' 💕' : '');

        const badge = document.createElement('span');
        badge.className = 'role-badge';
        if (!player.alive) {
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

    if (gameState.phase === 'amor') {
        renderAmorActions(container);
        return;
    }

    if (gameState.phase === 'amor_notify') {
        const msg = document.createElement('div');
        msg.className = 'alert alert-warning py-2 mb-0 text-center';
        if (loverPartnerName) {
            msg.innerHTML = `💕 Du und <strong>${escapeHtml(loverPartnerName)}</strong> seid verliebt!<br>
                <small class="text-muted">Ihr gewinnt nur, wenn ihr beide bis zum Ende überlebt.</small>`;
        } else {
            msg.textContent = '💘 Das Liebespaar wird benachrichtigt...';
        }
        container.appendChild(msg);
        return;
    }

    if (gameState.phase === 'witch') {
        renderWitchActions(container);
        return;
    }

    if (gameState.phase === 'seer') {
        renderSeerActions(container);
        return;
    }

    if (gameState.phase === 'night' && gameState.isWerewolfVoting) {
        renderWerewolfVotingActions(container);
        return;
    }

    if (gameState.phase === 'voting') {
        renderDayVotingActions(container);
        return;
    }

    if (gameState.phase === 'hunter_revenge') {
        renderHunterRevengeActions(container);
        return;
    }

    if (gameState.phase === 'result') {
        const msg = document.createElement('p');
        msg.className = 'text-muted mb-0 text-center';
        msg.textContent = '🌙 Die Nacht beginnt gleich...';
        container.appendChild(msg);
        return;
    }

    if (gameState.phase === 'game_over_results') {
        const msg = document.createElement('div');
        msg.className = 'alert alert-success py-3 mb-3 text-center';
        msg.innerHTML = '<i class="bi bi-confetti me-2"></i>Die Ergebnisse werden offengelegt...<i class="bi bi-confetti ms-2"></i>';
        container.appendChild(msg);

        if (amILeader()) {
            const btn = document.createElement('button');
            btn.id = 'gameOverNextPhaseBtn';
            btn.className = 'btn btn-primary mt-1';
            btn.onclick = nextPhaseServer;
            btn.innerHTML = '<i class="bi bi-trophy-fill me-1"></i> Ergebnis anzeigen';
            container.appendChild(btn);
        }
        return;
    }

    if (gameState.phase === 'day') {
        const msg = gameState.isFirstDay
            ? '<p>Alle schlafen noch. Der Leiter startet die erste Runde.</p>'
            : '<p>Tag-Phase – Die Dorfbewohner beraten sich. Nach der Diskussion startet der Leiter die Abstimmung.</p>';
        container.innerHTML = msg;

        if (myRole() === 'seer' && seerRevealResult) {
            const info = document.createElement('div');
            info.className = 'alert alert-info py-2 mb-2';
            info.innerHTML = `🔮 Deine letzte Inspektion: <strong>${escapeHtml(seerRevealResult.player)}</strong> ist ein <strong>${roleDisplayName(seerRevealResult.role)}</strong>`;
            container.insertBefore(info, container.firstChild);
        }

        if (amILeader()) container.appendChild(makeNextPhaseBtn());
        return;
    }
}


// ---------------------------------------------------------------
// Werwolf-Abstimmung (simultan, alle Wölfe gleichzeitig)
// ---------------------------------------------------------------
function renderWerewolfVotingActions(container) {
    const amIWolf = myRole() === 'werewolf';

    if (!amIWolf) {
        const msg = document.createElement('p');
        msg.className = 'text-muted mb-0';
        msg.textContent = '🌙 Die Werwölfe stimmen ab...';
        container.appendChild(msg);
        return;
    }

    // Ich bin ein Wolf: zeige Abstimmungs-UI
    const title = document.createElement('p');
    title.className = 'fw-semibold mb-2';
    title.textContent = '🐺 Wen wollt ihr fressen? (Nur ihr Wölfe seht das)';
    container.appendChild(title);

    if (_myVoteTarget) {
        // Ich habe schon abgestimmt
        const confirmed = document.createElement('div');
        confirmed.className = 'alert alert-success py-2 mb-2';
        confirmed.innerHTML = `✅ Du hast für <strong>${escapeHtml(_myVoteTarget)}</strong> gestimmt. Warte auf die anderen...`;
        container.appendChild(confirmed);
    } else {
        // Abstimmungs-Buttons
        const grid = document.createElement('div');
        grid.className = 'd-flex flex-wrap gap-2 mb-2';

        const targets = gameState.players
            .filter(p => p.alive && p.role !== 'werewolf')
            .map(p => p.name);
        targets.push('Niemanden');

        targets.forEach(target => {
            const btn = document.createElement('button');
            btn.className = target === 'Niemanden'
                ? 'btn btn-outline-secondary vote-btn'
                : 'btn btn-outline-danger vote-btn';
            btn.textContent = target;
            btn.onclick = () => {
                _myVoteTarget = target;
                castVote(target);
                renderActions();
            };
            grid.appendChild(btn);
        });
        container.appendChild(grid);
    }

    // Zeige wer von den Wölfen schon abgestimmt hat
    renderVotedProgress(container, 'wolf');
}


// ---------------------------------------------------------------
// Tages-Abstimmung (simultan, alle lebenden Spieler)
// ---------------------------------------------------------------
function renderDayVotingActions(container) {
    const alive = amIAlive();

    if (!alive) {
        const msg = document.createElement('p');
        msg.className = 'text-muted mb-0';
        msg.textContent = '💀 Du bist tot und kannst nicht mehr abstimmen.';
        container.appendChild(msg);
        renderVotedProgress(container, 'village');
        return;
    }

    const title = document.createElement('p');
    title.className = 'fw-semibold mb-2';
    title.textContent = '🗳️ Wen verdächtigst du?';
    container.appendChild(title);

    if (_myVoteTarget) {
        // Ich habe schon abgestimmt
        const confirmed = document.createElement('div');
        confirmed.className = 'alert alert-success py-2 mb-2';
        confirmed.innerHTML = `✅ Du hast für <strong>${escapeHtml(_myVoteTarget)}</strong> gestimmt. Warte auf den Countdown...`;
        container.appendChild(confirmed);
    } else {
        const grid = document.createElement('div');
        grid.className = 'd-flex flex-wrap gap-2 mb-2';

        const targets = gameState.players.filter(p => p.alive).map(p => p.name);
        targets.push('Niemanden');

        targets.forEach(target => {
            const btn = document.createElement('button');
            btn.className = target === 'Niemanden'
                ? 'btn btn-outline-secondary vote-btn'
                : 'btn btn-outline-danger vote-btn';
            btn.textContent = target;
            btn.onclick = () => {
                _myVoteTarget = target;
                castVote(target);
                renderActions();
            };
            grid.appendChild(btn);
        });
        container.appendChild(grid);
    }

    // Zeige wer schon abgestimmt hat
    renderVotedProgress(container, 'village');
}


// ---------------------------------------------------------------
// Fortschritt: Wer hat schon abgestimmt (ohne Ziele)
// ---------------------------------------------------------------
function renderVotedProgress(container, type) {
    const hasVoted = gameState.hasVotedNames || [];
    const eligible = type === 'wolf'
        ? gameState.players.filter(p => p.role === 'werewolf' && p.alive)
        : gameState.players.filter(p => p.alive);

    if (eligible.length === 0) return;

    const div = document.createElement('div');
    div.className = 'voted-progress mt-2';
    div.innerHTML = `<span class="text-muted">${hasVoted.length}/${eligible.length} abgestimmt:</span> `;

    if (hasVoted.length === 0) {
        div.innerHTML += '<span class="text-muted">–</span>';
    } else {
        hasVoted.forEach(name => {
            const chip = document.createElement('span');
            chip.className = 'voted-chip';
            chip.innerHTML = '✓ ' + escapeHtml(name);
            div.appendChild(chip);
        });
    }

    container.appendChild(div);
}


// ---------------------------------------------------------------
// Amor-Aktionen
// ---------------------------------------------------------------
function renderAmorActions(container) {
    const iAmAmor = myRole() === 'amor';

    if (!iAmAmor) {
        const msg = document.createElement('p');
        msg.className = 'text-muted mb-0';
        msg.textContent = '💘 Amor verliebt zwei Personen...';
        container.appendChild(msg);
        if (amILeader()) container.appendChild(makeSkipBtn());
        return;
    }

    const title = document.createElement('p');
    title.className = 'fw-semibold mb-2';
    title.textContent = '💘 Du bist Amor! Wähle 2 Spieler als Liebespaar (nicht dich selbst):';
    container.appendChild(title);

    if (_amorSelected.length > 0) {
        const info = document.createElement('div');
        info.className = 'alert alert-warning py-2 mb-2';
        info.innerHTML = 'Ausgewählt: ' + _amorSelected.map(n => `<strong>${escapeHtml(n)}</strong>`).join(' & ');
        container.appendChild(info);
    }

    const grid = document.createElement('div');
    grid.className = 'd-flex flex-wrap gap-2 mb-2';

    gameState.players.filter(p => p.alive && p.name !== currentPlayerName).forEach(p => {
        const isSelected = _amorSelected.includes(p.name);
        const btn = document.createElement('button');
        btn.className = 'btn ' + (isSelected ? 'btn-warning' : 'btn-outline-warning') + ' vote-btn';
        btn.textContent = isSelected ? `💕 ${p.name}` : p.name;
        btn.onclick = () => {
            if (isSelected) {
                _amorSelected = _amorSelected.filter(n => n !== p.name);
            } else if (_amorSelected.length < 2) {
                _amorSelected = [..._amorSelected, p.name];
            }
            renderActions();
        };
        grid.appendChild(btn);
    });
    container.appendChild(grid);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-warning mt-1';
    confirmBtn.innerHTML = '<i class="bi bi-heart-fill me-1"></i> Liebespaar bestätigen';
    confirmBtn.disabled = _amorSelected.length !== 2;
    confirmBtn.onclick = () => {
        sendAmorAction(_amorSelected[0], _amorSelected[1]);
        _amorSelected = [];
    };
    container.appendChild(confirmBtn);
}


// ---------------------------------------------------------------
// Jäger-Rache
// ---------------------------------------------------------------
function renderHunterRevengeActions(container) {
    const iAmHunter = myRole() === 'hunter';

    if (!iAmHunter || amIAlive()) {
        const msg = document.createElement('p');
        msg.className = 'text-muted mb-0';
        msg.textContent = '🎯 Der Jäger wählt sein letztes Opfer...';
        container.appendChild(msg);
        return;
    }

    const title = document.createElement('p');
    title.className = 'fw-semibold mb-2';
    title.textContent = '🎯 Du bist gestorben! Wähle ein letztes Opfer (oder verzichte):';
    container.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'd-flex flex-wrap gap-2 mb-2';

    gameState.players.filter(p => p.alive).forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-outline-danger vote-btn';
        btn.textContent = p.name;
        btn.onclick = () => {
            sendHunterRevenge(p.name);
        };
        grid.appendChild(btn);
    });
    container.appendChild(grid);

    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn-outline-secondary btn-sm mt-1';
    skipBtn.textContent = 'Kein Opfer wählen';
    skipBtn.onclick = () => sendHunterRevenge(null);
    container.appendChild(skipBtn);
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
        if (amILeader()) container.appendChild(makeSkipBtn());
        return;
    }

    const title = document.createElement('p');
    title.className = 'fw-semibold mb-3';
    title.textContent = '🧙 Du bist die Hexe! Entscheide deine Aktionen:';
    container.appendChild(title);

    const victimInfo = document.createElement('div');
    victimInfo.className = 'alert alert-info py-2 mb-3';
    if (witchNightVictim) {
        victimInfo.innerHTML = `🌙 Die Werwölfe wählen <strong>${escapeHtml(witchNightVictim)}</strong>.`;
    } else {
        victimInfo.textContent = '🌙 Die Werwölfe wählen niemanden.';
    }
    container.appendChild(victimInfo);

    // Heiltrank
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
            renderActions();
        };
        healSection.appendChild(healBtn);
        container.appendChild(healSection);
    } else if (gameState.witchHealUsed) {
        const used = document.createElement('p');
        used.className = 'text-muted small mb-3';
        used.textContent = '💊 Heiltrank bereits verbraucht.';
        container.appendChild(used);
    }

    // Gifttrank
    if (!gameState.witchPoisonUsed) {
        const poisonSection = document.createElement('div');
        poisonSection.className = 'mb-3';

        const poisonLabel = document.createElement('p');
        poisonLabel.className = 'fw-semibold mb-1';
        poisonLabel.innerHTML = '☠️ Gifttrank <span class="badge bg-danger ms-1">1× verfügbar</span>';
        poisonSection.appendChild(poisonLabel);

        const poisonGrid = document.createElement('div');
        poisonGrid.className = 'd-flex flex-wrap gap-2';

        gameState.players.filter(p => p.alive && p.name !== currentPlayerName).forEach(p => {
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

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary mt-1';
    confirmBtn.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i> Aktion bestätigen';
    confirmBtn.onclick = () => {
        sendWitchAction(_witchHealToggled, _witchPoisonSelected);
        _witchHealToggled    = false;
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
        if (amILeader()) container.appendChild(makeSkipBtn());
        return;
    }

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

    gameState.players.filter(p => p.alive && p.name !== currentPlayerName).forEach(p => {
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
    btn.onclick = nextPhaseServer;

    // Tag-Phase nach Nacht: 15s Mindestwartezeit, Button erst dann freischalten
    if (gameState.phase === 'day' && gameState.afterNight) {
        btn.id = 'dayNextPhaseBtn';
        const endsAt   = gameState.countdownEnd;
        const duration = gameState.countdownDuration;
        if (endsAt && duration) {
            const buttonActiveAt = endsAt - (duration - 15) * 1000;
            const isLocked = Date.now() < buttonActiveAt;
            btn.disabled = isLocked;
            if (isLocked) {
                const lockSec = Math.ceil((buttonActiveAt - Date.now()) / 1000);
                btn.innerHTML = `<i class="bi bi-lock-fill me-1"></i> Abstimmung in ${lockSec}s`;
            } else {
                btn.innerHTML = '<i class="bi bi-arrow-right-circle-fill me-1"></i> Abstimmung starten';
            }
        } else {
            btn.innerHTML = '<i class="bi bi-arrow-right-circle-fill me-1"></i> Abstimmung starten';
        }
        return btn;
    }

    btn.innerHTML = '<i class="bi bi-arrow-right-circle-fill me-1"></i> Nächste Phase';
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

    const leaderCard   = document.getElementById('leaderSettingsCard');
    const readOnlyCard = document.getElementById('settingsReadOnly');
    const startBtn     = document.getElementById('startGame');
    const leaderHint   = document.getElementById('lobbyLeaderHint');

    if (amILeader()) {
        leaderCard.classList.remove('d-none');
        readOnlyCard.classList.add('d-none');
        startBtn.classList.remove('d-none');
        leaderHint.classList.add('d-none');

        // Checkboxen synchronisieren
        const witchCheck  = document.getElementById('roleWitch');
        const seerCheck   = document.getElementById('roleSeer');
        const hunterCheck = document.getElementById('roleHunter');
        const amorCheck   = document.getElementById('roleAmor');
        if (witchCheck)  witchCheck.checked  = !!(gameState.activeRoles?.witch);
        if (seerCheck)   seerCheck.checked   = !!(gameState.activeRoles?.seer);
        if (hunterCheck) hunterCheck.checked = !!(gameState.activeRoles?.hunter);
        if (amorCheck)   amorCheck.checked   = !!(gameState.activeRoles?.amor);

        // Voting-Duration Radio synchronisieren
        const dur = gameState.votingDuration || 60;
        const radios = document.querySelectorAll('input[name="votingDuration"]');
        radios.forEach(r => { r.checked = (parseInt(r.value) === dur); });
    } else {
        leaderCard.classList.add('d-none');
        readOnlyCard.classList.remove('d-none');
        document.getElementById('werewolfCountDisplay').textContent = gameState.numWerewolves ?? 1;

        const rolesEl = document.getElementById('activeRolesDisplay');
        const active = [];
        if (gameState.activeRoles?.witch)   active.push('🧙 Hexe');
        if (gameState.activeRoles?.seer)    active.push('🔮 Seherin');
        if (gameState.activeRoles?.hunter)  active.push('🎯 Jäger');
        if (gameState.activeRoles?.amor)    active.push('💘 Amor');
        rolesEl.textContent = active.length
            ? 'Sonderrollen: ' + active.join(', ')
            : 'Keine Sonderrollen aktiv';

        const durEl = document.getElementById('votingDurationDisplay');
        if (durEl) durEl.textContent = (gameState.votingDuration || 60) + ' s';

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

    const amIWolf = myRole() === 'werewolf';
    const isNight = gameState.phase === 'night';
    const meAlive = gameState.players.find(p => p.name === currentPlayerName)?.alive ?? false;

    if (!amIWolf || !isNight) {
        section.classList.add('d-none');
        return;
    }

    section.classList.remove('d-none');

    const canWrite = meAlive;
    input.disabled   = !canWrite;
    sendBtn.disabled = !canWrite;
    input.placeholder = canWrite ? 'Nachricht an Werwölfe...' : '💀 Nur lebende Werwölfe können schreiben';

    quickDiv.innerHTML = '';
    if (canWrite) {
        gameState.players.filter(p => p.alive && p.role !== 'werewolf').forEach(p => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-outline-danger wolf-quick-btn';
            btn.textContent = `Lass uns ${p.name} wählen`;
            btn.onclick = () => sendWerewolfChat(`Lass uns ${p.name} wählen`);
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
    const canChat = (gameState.phase === 'day'  || gameState.phase === 'voting' ||
                     gameState.phase === 'result' || gameState.phase === 'amor_notify' ||
                     gameState.phase === 'game_over_results');
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
        case 'hunter':   return '🎯 Jäger';
        case 'amor':     return '💘 Amor';
        default:         return role || '?';
    }
}

function roleShortName(role) {
    switch (role) {
        case 'werewolf': return 'Werwolf';
        case 'witch':    return 'Hexe';
        case 'seer':     return 'Seherin';
        case 'villager': return 'Dorfbewohner';
        case 'hunter':   return 'Jäger';
        case 'amor':     return 'Amor';
        default:         return role || '?';
    }
}

function roleBadgeClass(role) {
    switch (role) {
        case 'werewolf': return 'role-werewolf';
        case 'witch':    return 'role-witch';
        case 'seer':     return 'role-seer';
        case 'villager': return 'role-villager';
        case 'hunter':   return 'role-hunter';
        case 'amor':     return 'role-amor';
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

// Leiter-Einstellungen: sofort senden wenn etwas geändert wird
let _lobbySettingsTimer = null;
function emitLobbySettings() {
    clearTimeout(_lobbySettingsTimer);
    _lobbySettingsTimer = setTimeout(() => {
        const num    = parseInt(document.getElementById('numWerewolves').value) || 1;
        const witch  = document.getElementById('roleWitch')?.checked   || false;
        const seer   = document.getElementById('roleSeer')?.checked    || false;
        const hunter = document.getElementById('roleHunter')?.checked  || false;
        const amor   = document.getElementById('roleAmor')?.checked    || false;
        const durEl  = document.querySelector('input[name="votingDuration"]:checked');
        const dur    = durEl ? parseInt(durEl.value) : 60;
        sendLobbySettings(num, { witch, seer, hunter, amor }, dur);
    }, 150);
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
document.getElementById('roleHunter').addEventListener('change', () => {
    if (amILeader()) emitLobbySettings();
});
document.getElementById('roleAmor').addEventListener('change', () => {
    if (amILeader()) emitLobbySettings();
});
document.querySelectorAll('input[name="votingDuration"]').forEach(radio => {
    radio.addEventListener('change', () => {
        if (amILeader()) emitLobbySettings();
    });
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
