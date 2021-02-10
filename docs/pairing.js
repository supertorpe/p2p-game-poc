const { MeshConfig, Mesh } = mplaynet;

//mplaynet.setDebug(true);

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

generateRandomLetters = (length) => {
  let code = '';
  for (let i = 0; i < length; i++) {
    const ndx = Math.floor(Math.random() * LETTERS.length);
    code += LETTERS[ndx];
  }
  return code;
};

const myUUID = generateRandomLetters(10);
console.log(myUUID);

/*******************************
 * BIND HTML ELEMENTS & EVENTS *
 *******************************/

const container = document.querySelector('.container');
const btnHostGame = document.querySelector('#btnHostGame');
const btnJoinGame = document.querySelector('#btnJoinGame');
const firstStep = document.querySelector('.firstStep');
const hostGame = document.querySelector('.hostGame');
const joinGame = document.querySelector('.joinGame');
const inputHostUsername = document.querySelector('#inputHostUsername');
const btnHost = document.querySelector('#btnHost');
const inputRoomCode = document.querySelector('#inputRoomCode');
const inputJoinUsername = document.querySelector('#inputJoinUsername');
const btnJoin = document.querySelector('#btnJoin');
const roomCodeLabel = document.querySelector('#roomCodeLabel');
const numPlayersLabel = document.querySelector('#numPlayersLabel');
const numPlayersReadyLabel = document.querySelector('#numPlayersReadyLabel');
const btnReady = document.querySelector('#btnReady');
const waiting = document.querySelector('.waiting');

btnHostGame.addEventListener('click', () => {
  firstStep.style.display = 'none';
  hostGame.style.display = 'flex';
});
btnJoinGame.addEventListener('click', () => {
  firstStep.style.display = 'none';
  joinGame.style.display = 'flex';
});
btnHost.addEventListener('click', () => {
  inputHostUsername.style.borderColor = 'black';
  if (!inputHostUsername.value) {
    inputHostUsername.style.borderColor = 'red';
    return;
  }
  btnHost.disabled = true;
  const roomId = generateRandomLetters(4);
  const username = inputHostUsername.value;
  signaller.hostRoom(roomId, username, myUUID);
});
btnJoin.addEventListener('click', () => {
  inputRoomCode.style.borderColor = 'black';
  inputJoinUsername.style.borderColor = 'black';
  let error = false;
  if (!inputRoomCode.value) {
    inputRoomCode.style.borderColor = 'red';
    error = true;
  }
  if (!inputJoinUsername.value) {
    inputJoinUsername.style.borderColor = 'red';
    error = true;
  }
  if (error) return;
  btnJoin.disabled = true;
  const roomId = inputRoomCode.value.toUpperCase();
  const username = inputJoinUsername.value;
  signaller.joinRoom(roomId, username, myUUID).then((ok) => {
    if (!ok) {
      alert('Room does not exists');
      btnJoin.disabled = false;
    }
  });
});
btnReady.addEventListener('click', () => {
  signaller.upatePlayerStatus(true);
  btnReady.style.display = 'none';
});

/*************
 * MESH      *
 *************/

const meshConfig = new MeshConfig(
  {
    iceServers: [
      { urls: 'stun:supertorpe.ignorelist.com:16310' },
      {
        urls: 'turn:supertorpe.ignorelist.com:16310',
        username: 'usuario',
        credential: 'clave',
      },
    ],
  },
  {
    ordered: false
  },
  1000, // messagesAwaitingReplyMaxSize
  10000, // messagesAwaitingReplyMaxAge
  5000, // messagesAwaitingReplyCleanerInterval
  2000 //checkLatencyInterval
);

const mesh = new Mesh(meshConfig, myUUID);

/*************
 * SIGNALING *
 *************/

let peers;

signaller.roomRecordEmitter.addEventListener((uuid, event) => {
  console.log('room info changed: ' + JSON.stringify(event));
  hostGame.style.display = 'none';
  joinGame.style.display = 'none';
  waiting.style.display = 'flex';
  roomCodeLabel.innerHTML = event.roomId;
  numPlayersLabel.innerHTML = event.peers.length;
  numPlayersReadyLabel.innerHTML = event.peers.reduce(
    (total, peer) => (peer.ready ? ++total : total),
    0
  );
  // all (n > 1) players ready ?
  if (event.peers.length > 1 && event.peers.every((peer) => peer.ready)) {
    signaller.startPairings(mesh).then((ok) => {
      if (ok) {
        peers = event.peers;
        // If I'm first peer, send the other peers a proposed delta time to start.
        // If I am not the first peer, wait for the proposal (see (1) below)
        if (event.peers[0].uuid === myUUID) {
          // wait 5s for clocks synchronization
          setTimeout(() => {
            const deltaTimeToStart = 2; // in 2 seconds the game will start
            const message = new Uint8Array(2);
            message[0] = 33; // 33 == delta time proposal
            message[1] = deltaTimeToStart;
            let peersConfirmed = 0;
            mesh.broadcastAndListen(message.buffer).forEach((promise) =>
              promise.then((reply) => {
                peersConfirmed++;
                if (peersConfirmed === event.peers.length - 1) {
                  container.style.display = 'none';
                  startGame(
                    event.peers,
                    mesh,
                    reply.sourceTimestamp + deltaTimeToStart * 1000
                  );
                }
              })
            );
          }, 5000);
        }
      } else {
        alert('Error while paring players');
      }
    });
  }
});

// (1)
mesh.messageEmitter.addEventListener((uuid, message) => {
  const info = new Int8Array(message.body);
  if (info[0] === 33) {
    // 33 == delta time proposal
    // send the reply
    const response = new Uint8Array(1);
    response[0] = 34; // 34 == delta time proposal accepted
    mesh.reply(uuid, message, response);
    // calc startTime
    const deltaTimeToStart = info[1];
    container.style.display = 'none';
    startGame(
      peers,
      mesh,
      message.timestampToLocalTime + deltaTimeToStart * 1000
    );
  }
});

let game;

const startGame = (peers, mesh, timeToStart) => {
  console.log(`timeToStart=${timeToStart}`);
  /*
    const message = `broadcast greeting: hello, I am ${myUUID}!`;
      const greeting = new TextEncoder().encode(message).buffer;
      mesh.broadcast(greeting);
//*/
  //*
  game = new Phaser.Game({
    parent: 'game-container',
    width: 500,
    height: 500,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: new MainScene(peers, mesh, timeToStart),
  });
  //*/
};
