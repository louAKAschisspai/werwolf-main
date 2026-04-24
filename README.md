# Werwolf – Verteiltes Multiplayer-Spiel

Browserbasiertes Werwolf-Spiel mit Echtzeit-Kommunikation über WebSockets. Unterstützt Sonderrollen (Hexe, Seherin), einen Lobby-System mit Spielleiter, In-Game-Chat und geheimen Werwolf-Chat.

## Architektur

```
Browser (HTML/CSS/JS + Bootstrap)
        │  WebSocket (Socket.io)
        ▼
    Nginx (Reverse Proxy + Failover)
    ├── Node.js Server 1  (primär)
    ├── Node.js Server 2  (Failover)
    └── Node.js Server 3  (Failover)
        │
        ├── MariaDB   (Spielzustand, Persistenz)
        └── Redis     (Socket.io Adapter für Server-Synchronisation)
```

- **3 Node.js-Instanzen** hinter Nginx: fällt ein Server aus, übernimmt automatisch ein anderer
- **MariaDB** persistiert Räume, Spieler und Abstimmungen — Spielstand überlebt Server-Neustarts
- **Redis** synchronisiert WebSocket-Events zwischen den drei Instanzen
- **Rollen:** Werwolf, Dorfbewohner, Hexe (Heil-/Gifttrank), Seherin (Rolleninspektion), Jäger (Vergeltungsschuss), Amor (Liebespaar)

## Befehle

### Lokal entwickeln

```bash
# Starten (erstes Mal oder nach Code-Änderungen)
docker compose up -d --build

# Starten ohne Rebuild (schneller, wenn kein Code geändert)
docker compose up -d


# Stoppen (Daten bleiben erhalten)
docker compose down

# Stoppen + Datenbank zurücksetzen (Empfohlen nach dem Spielen)
docker compose down -v 

# Einzelnen Container neu starten
docker compose restart server
```

Erreichbar unter: **http://localhost**  
phpMyAdmin: **http://localhost:8085**



### Online spielen ohne Server (Cloudflare Tunnel)

```bash
# Spiel lokal starten, dann Tunnel öffnen(benötigt vorherige installation mit: brew install cloudflare/cloudflare/cloudflared)
cloudflared tunnel --url http://localhost:80
# → gibt eine öffentliche https://....trycloudflare.com URL aus
```


