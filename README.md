# Werwolf – Verteiltes Multiplayer-System

Dieses Projekt dient als Grundlage für ein verteiltes Multiplayer-Spiel (z. B. Werwolf).

Aktuell enthält das Projekt eine minimale Express-Server-Konfiguration, die über Docker containerisiert ist und ein einfaches „Hello World“-Frontend ausliefert.

## Architektur

Das System basiert auf einer Client-Server-Architektur:

- Node.js (Express) Backend
- Docker-basierte Container-Struktur
- Optional erweiterbar um MariaDB
- Frontend flexibel wählbar:
    - Web-Frontend (JavaScript/HTML)
    - Game-Client mit Godot Engine

Das Backend ist unabhängig vom Frontend konzipiert.  
Sowohl ein Web-Client als auch ein Godot-Client können mit demselben Server kommunizieren.

## Projekt starten

```bash
docker compose up --build