# mGBA Online - WebRTC P2P (GitHub Pages, senza broker)

Emulatore mGBA nel browser con Link Cable multiplayer **peer-to-peer**, pubblicabile su
GitHub Pages. In questa versione **non c'e' piu' PeerJS Cloud**: la "segnalazione" iniziale
avviene copiando/incollando un link tra i due giocatori.

## Cosa puo' (e non puo') fare GitHub

GitHub Pages serve **solo file statici**. Non puo' ne' fare da relay, ne' tenere aperta una
connessione, ne' far incontrare due browser. Una connessione WebRTC ha bisogno di 3 cose:

| Pezzo | A cosa serve | Chi lo da' qui |
|---|---|---|
| Segnalazione | scambio di offerta/risposta (SDP + candidati ICE) | **i due giocatori a mano** (link/codice in chat) |
| STUN | scoprire il proprio IP pubblico dietro il router | server STUN pubblici (Google/Cloudflare). Non vedono i dati di gioco |
| TURN | relay di ripiego quando i NAT non si bucano | **nessuno**: GitHub non offre un TURN, nemmeno gratuito |

Alternative "dentro GitHub" valutate e scartate: l'API di Gist/Issues richiede un token (che
non puo' stare in una pagina pubblica), GitHub Actions non e' in tempo reale, e un relay su
Codespaces ha ore gratuite limitate e deve restare acceso.

**Conseguenza onesta:** funziona quando almeno uno dei due NAT e' "bucabile" (la grande
maggioranza dei casi domestici), oppure con IPv6, oppure in LAN. Se entrambi i lati sono dietro
NAT simmetrico/CGNAT (tipico di alcune reti mobili) la connessione diretta e' impossibile e
senza un TURN esterno non c'e' soluzione.

## Come si gioca

1. Entrambi aprite la pagina e caricate la **stessa ROM** (`[ROM] Carica .gba`).
2. **Host**: `[ONLINE]` -> *Ospita Stanza* -> `[+] Crea Invito P2P` -> `[Copia] Link Diretto` e lo manda al compagno.
3. **Guest**: apre il link (il codice si compila da solo) -> `[->] Genera Risposta` -> `[Copia] Risposta` e la rimanda all'Host.
4. **Host**: incolla la risposta nel Passo 2 e preme `[->] Collega`.
5. Connessione, scambio dei `.sav` e avvio partono da soli.

> **Fate il passo 3-4 in fretta (entro ~30 s).** Il guest comincia a "bussare" non appena genera
> la risposta; se l'Host ci mette troppo, i controlli ICE scadono e serve un nuovo invito.

## Pubblicazione su GitHub Pages

Il contenuto di questa cartella deve essere la radice del sito (o una sottocartella servita da Pages):
`index.html`, `app.js`, `p2p-link.js`, `style.css`, `cores/`.
Settings -> Pages -> Branch `main` / `(root)`. Se tieni l'intero repo con piu' cartelle, l'URL sara'
`https://UTENTE.github.io/REPO/github-pages-webrtc/`.

La ROM **non e' inclusa** (e non va committata): ognuno carica la propria. Se vuoi comunque una ROM
predefinita nel repo, imposta `DEFAULT_ROM_URL` in `app.js` (vuota = nessuna richiesta, quindi nessun 404).

## TURN opzionale

Se hai un tuo server TURN (o un servizio a cui ti sei iscritto), aggiungilo in `P2P_ICE_SERVERS` in `app.js`:

```js
{ urls: "turn:turn.example.com:3478", username: "utente", credential: "password" }
```

## Struttura

- `p2p-link.js` - `RTCPeerConnection` nativa, codici invito/risposta compressi, due DataChannel:
  `ctrl` (affidabile: handshake e `.sav`, con frammentazione) e `input` (senza ritrasmissioni: ogni
  pacchetto ripete gli ultimi frame, quindi un pacchetto perso non blocca il lockstep).
- `app.js` - emulazione, lockstep, UI. La parte rete e' tra `P2P_ICE_SERVERS` e `handleP2PDisconnect`.

## Test

`tests/` contiene un test end-to-end (due pagine jsdom + stack WebRTC reale `werift` + core finto):

```bash
cd tests && npm install && npm test
```
