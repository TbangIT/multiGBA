# net/ - rete, un file per concetto

Ordine di caricamento (index.html): librerie -> moduli `net/` -> `app.js`. Sono script classici: condividono lo scope globale.

| File | Compito |
|---|---|
| `webrtc-link.js` | server ICE, canale dati "veloce" non ordinato per input/ping, fallback sul canale affidabile, `netSend()` |
| `mqtt-codec.js` | cifratura AES-GCM (chiave dal codice stanza), frammentazione, JSON con binari |
| `mqtt-brokers.js` | elenco broker pubblici, connessione con timeout, misura della latenza reale |
| `mqtt-link.js` | relay MQTT: `MqttConn` (stessa interfaccia di PeerJS), host, guest, failover |
| `lockstep-timing.js` | delay input adattivo (in ms reali, scala con la velocita'), ping/RTT per giocatore, stalli, carico CPU, profili lag |
| `perf-monitor.js` | diagnostica: rete o CPU? Pannello F3, profilo lag F4, report copiabile |
| `sram-codec.js` | compressione dei salvataggi .sav per l'avvio |
| `vendor/mqtt.min.js` | mqtt.js 5.16.1 (MIT), incluso: nessuna CDN |

## Come funziona il relay MQTT
1. L'host crea la stanza su WebRTC **e** si collega ai broker MQTT, scegliendo il piu' veloce (eco misurata).
2. Il guest prova WebRTC; se da' errore, ICE fallisce o non si apre in 6 s, si collega a TUTTI i broker e ripete `JOIN`.
   Il primo `WELCOME` decide il broker della stanza.
3. `MqttConn` espone `on/send/close/open` come PeerJS: lobby, avvio e lockstep non cambiano.
4. Input: ogni giocatore pubblica UNA volta su `B/in`, il broker distribuisce (l'host non rilancia).
   Ping e messaggi di controllo restano punto-a-punto (RTT per giocatore, QoS1 per i controlli).
5. Failover: broker irraggiungibile per 4 s -> tutti passano al successivo nell'ORDINE FISSO dell'elenco.
6. Privacy: broker pubblici = chiunque puo' leggere i topic, quindi tutto e' cifrato. Il codice stanza e' di 4 cifre:
   la cifratura ferma curiosi e disturbatori occasionali, non un attaccante che prova i 10.000 codici offline.

Broker propri: `?mqtt=wss://mio-broker:8084/mqtt,wss://altro:8084/mqtt` oppure `window.REBIT_MQTT_BROKERS = [...]`.
Solo WebRTC (come prima): non serve fare nulla se MQTT non e' raggiungibile. Solo canale affidabile: `?fast=0`.
