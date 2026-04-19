-- Räume: ein Eintrag pro laufendem Spiel
CREATE TABLE IF NOT EXISTS rooms (
    room_id              VARCHAR(50)  PRIMARY KEY,
    phase                VARCHAR(50)  NOT NULL DEFAULT 'lobby',
    round                INT          NOT NULL DEFAULT 0,
    num_werewolves       INT          NOT NULL DEFAULT 1,
    is_first_day         TINYINT(1)   NOT NULL DEFAULT 0,
    after_night          TINYINT(1)   NOT NULL DEFAULT 0,
    killed_in_night      VARCHAR(100),
    voting_result        VARCHAR(100),
    voting_round         INT          NOT NULL DEFAULT 1,
    is_werewolf_voting   TINYINT(1)   NOT NULL DEFAULT 0,
    current_voter_index  INT          NOT NULL DEFAULT 0,
    game_over            TINYINT(1)   NOT NULL DEFAULT 0,
    announcement         TEXT,
    active_witch         TINYINT(1)   NOT NULL DEFAULT 0,
    active_seer          TINYINT(1)   NOT NULL DEFAULT 0,
    witch_heal_used      TINYINT(1)   NOT NULL DEFAULT 0,
    witch_poison_used    TINYINT(1)   NOT NULL DEFAULT 0,
    night_victim         VARCHAR(100),
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Migration: Spalten für bestehende Datenbanken hinzufügen (MariaDB/MySQL 5.6+)
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active_witch      TINYINT(1)   NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active_seer       TINYINT(1)   NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS witch_heal_used   TINYINT(1)   NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS witch_poison_used TINYINT(1)   NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS night_victim      VARCHAR(100);

-- Spieler: gehören zu einem Raum
CREATE TABLE IF NOT EXISTS players (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    room_id     VARCHAR(50)  NOT NULL,
    name        VARCHAR(100) NOT NULL,
    socket_id   VARCHAR(100),
    role        VARCHAR(50),
    alive       TINYINT(1)   NOT NULL DEFAULT 1,
    join_order  INT          NOT NULL DEFAULT 0,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

-- Stimmen: Protokoll aller Abstimmungen
CREATE TABLE IF NOT EXISTS votes (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    room_id     VARCHAR(50)  NOT NULL,
    round       INT          NOT NULL,
    voter_name  VARCHAR(100) NOT NULL,
    target      VARCHAR(100) NOT NULL,
    vote_type   ENUM('werewolf', 'village') NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);
