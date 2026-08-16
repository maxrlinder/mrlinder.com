const TRYSTERO_MODULE = "https://esm.run/trystero@0.25.3";
const APP_ID = "mrlinder.com/plump/multiplayer-v1";
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 8;

let trysteroPromise = null;

function loadTrystero() {
  trysteroPromise ||= import(TRYSTERO_MODULE);
  return trysteroPromise;
}

export function normalizeRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .replace(/[IO01]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
}

export function validRoomCode(value) {
  const code = normalizeRoomCode(value);
  return code.length === ROOM_CODE_LENGTH && [...code].every((character) =>
    ROOM_ALPHABET.includes(character),
  );
}

export function generateRoomCode() {
  const values = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(values);
  return [...values]
    .map((value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length])
    .join("");
}

export class PlumpPeerRoom {
  constructor({ role, code, onMessage, onPeerJoin, onPeerLeave, onError }) {
    this.role = role;
    this.code = normalizeRoomCode(code);
    this.onMessage = onMessage;
    this.onPeerJoin = onPeerJoin;
    this.onPeerLeave = onPeerLeave;
    this.onError = onError;
    this.room = null;
    this.action = null;
  }

  async connect() {
    if (!validRoomCode(this.code)) throw new Error("Enter the complete 8-character table code.");
    const { joinRoom } = await loadTrystero();
    this.room = joinRoom(
      {
        appId: APP_ID,
        password: `plump:${this.code}:v1`,
        relayConfig: { redundancy: 4 },
      },
      `plump-${this.code}`,
      {
        onJoinError: ({ error }) => this.onError?.(
          error.includes("TURN")
            ? "A direct connection could not be made on this network. Try another Wi-Fi or mobile connection."
            : "The table connection failed. Check the code and try again.",
        ),
      },
    );
    this.action = this.room.makeAction("plump-v1");
    this.action.onMessage = (message, { peerId }) => this.onMessage?.(message, peerId);
    this.room.onPeerJoin = (peerId) => this.onPeerJoin?.(peerId);
    this.room.onPeerLeave = (peerId) => this.onPeerLeave?.(peerId);
    return this;
  }

  send(message, target = null) {
    if (!this.action) return Promise.reject(new Error("The table is not connected."));
    return this.action.send(message, { target });
  }

  async leave() {
    const room = this.room;
    this.action = null;
    this.room = null;
    if (room) await room.leave();
  }
}
