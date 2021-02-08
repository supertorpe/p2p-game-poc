const { getLocalTimestamp } = mplaynet;

const DEBUG = {
    GAMESTATE: false,
    SEND: false,
    RECEIVE: false,
    INFO: false,
    WARN: true
};
const STRENGTH = 40;
const TIMESLICE = 100;
const RENDER_DELAY = 2;
const WORLD_SCALE = 30; // Box2D works with meters. We need to convert meters to pixels. let's say 30 pixels = 1 meter.
const LAG_SIMULATION = 0;
const MAKE_INTERPOLATION = true;

class MainScene extends Phaser.Scene {
    constructor(peers, mesh, timeToStart) {
        super("mainScene");
        if (DEBUG.INFO) console.log(`getLocalTimestamp=${getLocalTimestamp()}`);
        this.ramdomGenerator = new MersenneTwister19937();
        this.ramdomGenerator.init_genrand(123456);
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.peers = peers;
        this.mesh = mesh;
        mesh.messageEmitter.addEventListener((uuid, message) => {
            this.messageReceived(uuid, message);
        });
        mesh.connectionReadyEmitter.addEventListener((uuid, ready) => {
            if (!ready) {
                // player disconnected
                const peer = peers.find((peer) => peer.uuid === uuid);
                peer.disconnected = true;
            }
        });
        this.gameHistory = [];
        this.commandBuffer = [];
        this.ramdomValues = [];
        this.running = false;
        this.timeToStart = timeToStart;
        this.messagesReceived = 0;
        this.messagesSent = 0;
    }

    preload() {
        this.load.image("sky", "./assets/sky.png");
        this.load.image("player", "./assets/player.png");
        this.load.image("enemy", "./assets/enemy.png");
        this.load.image("coin", "./assets/coin.png");
        this.load.audio("success", "./assets/success.mp3");
        const url =
            "https://raw.githubusercontent.com/rexrainbow/phaser3-rex-notes/master/dist/rexvirtualjoystickplugin.min.js";
        this.load.plugin("rexvirtualjoystickplugin", url, true);
    }

    create() {
        /////////////////// BACKGROUND ///////////////////
        this.add.image(400, 300, "sky");

        /////////////////// SCOREBOARD ///////////////////
        this.scoreTexts = [];
        const style = { font: "20px Arial", fill: "#fff" };
        for (let [index, peer] of this.peers.entries()) {
            this.scoreTexts[index] = this.add.text(
                20,
                20 + index * 30,
                `${peer.username}: 0`,
                style
            );
        }

        this.waitingText = this.add.text(170, 200, "waiting for sync ...", style);

        /////////////////// KEYBOARD ///////////////////
        this.arrow = this.input.keyboard.createCursorKeys();

        /////////////////// JOYSTICK ///////////////////
        this.joyStick = this.plugins.get("rexvirtualjoystickplugin").add(this, {
            x: 450,
            y: 450,
            radius: 25,
            base: this.add.circle(0, 0, 50, 0x888888),
            thumb: this.add.circle(0, 0, 25, 0xcccccc)
            // dir: '8dir',   // 'up&down'|0|'left&right'|1|'4dir'|2|'8dir'|3
            // forceMin: 16,
            // enable: true
        });
        this.joystickKeys = this.joyStick.createCursorKeys();

        /////////////////// INITIAL GAME STATE ///////////////////
        this.serializer = new planck.Serializer();
        const initialGameState = this.createInitialGameState();
        this.gameHistory.push(initialGameState);
        this.latestGameState = initialGameState;
        this.renderGameStateIdx = 0;
    }

    clone(object) {
        return this.serializer.fromJson(this.serializer.toJson(object));
    }

    update() {
        const timestamp = getLocalTimestamp();
        // wait to timeToStart
        if (!this.running && timestamp >= this.timeToStart) {
            this.running = true;
            if (DEBUG.INFO) console.log("running!!!");
            this.waitingText.setText("");
        }
        if (!this.running) {
            return;
        }
        // check if a new gamestate needs to be created
        const latestTimestamp =
            this.timeToStart + (1 + this.latestGameState.slice) * TIMESLICE;
        if (timestamp >= latestTimestamp) {
            // if there are gaps in history, fill it with fake gamestates
            const gapsInHistory = timestamp >= latestTimestamp + TIMESLICE;
            if (gapsInHistory) {
                const gamestatesToBuild = Math.ceil(
                    (timestamp - latestTimestamp) / TIMESLICE
                );
                if (DEBUG.WARN)
                    console.log(
                        `There are ${gamestatesToBuild} gaps in game history. Latest known gamestate: ${this.latestGameState.slice}`
                    );
                for (let i = 1; i < gamestatesToBuild; i++) {
                    this.gameHistory.push({
                        slice: this.latestGameState.slice + i,
                        time: this.latestGameState.time + i * TIMESLICE,
                        world: null,
                        bodies: [],
                        scores: [...this.latestGameState.scores],
                        ramdomPointer: this.latestGameState.ramdomPointer,
                        coinCollected: undefined,
                        commands: new Array(this.peers.length)
                    });
                }
            }
            // load commands into gameStates and check if history needs to be rewritten
            let rewriteHistoryFrom = this.loadCommandsIntoGameStates();
            if (
                gapsInHistory &&
                (rewriteHistoryFrom == null ||
                    this.latestGameState.slice < rewriteHistoryFrom.slice)
            ) {
                rewriteHistoryFrom = this.latestGameState;
            }
            if (rewriteHistoryFrom) {
                this.rewriteHistory(rewriteHistoryFrom);
            }
            this.latestGameState = this.nextGameState(
                this.gameHistory[this.gameHistory.length - 1]
            );
            if (DEBUG.GAMESTATE) this.debugGameState(this.latestGameState);
            this.gameHistory.push(this.latestGameState);
            // clean old gameHistory
            while (this.gameHistory.length > 100) {
                const worldToDestroy = this.gameHistory[0].world;
                for (let b = worldToDestroy.getBodyList(); b; b = b.getNext()) {
                    worldToDestroy.destroyBody(b);
                }
                this.gameHistory.shift();
            }
            if (this.gameHistory.length > RENDER_DELAY + 1) {
                this.renderGameStateIdx = this.gameHistory.length - (RENDER_DELAY + 1);
            }
        }

        let right =
            this.arrow.right.isDown ||
            (this.joystickKeys["right"] && this.joystickKeys["right"].isDown);
        let left =
            this.arrow.left.isDown ||
            (this.joystickKeys["left"] && this.joystickKeys["left"].isDown);
        let down =
            this.arrow.down.isDown ||
            (this.joystickKeys["down"] && this.joystickKeys["down"].isDown);
        let up =
            this.arrow.up.isDown ||
            (this.joystickKeys["up"] && this.joystickKeys["up"].isDown);

        let commandValue = (right ? 10 : left ? 20 : 0) + (down ? 1 : up ? 2 : 0);

        let command = this.latestGameState.commands[this.myIndex];
        if ((!command || command[2] === 0) && commandValue !== 0) {
            command = new Uint16Array(4);
            command[0] = 0;
            command[1] = this.myIndex;
            command[2] = commandValue;
            command[3] = this.latestGameState.slice;
            this.latestGameState.commands[this.myIndex] = command;
            if (DEBUG.SEND)
                console.log(
                    `send command: ${command[2]}, slice=${command[3]}. total=${++this
                        .messagesSent}`
                );
            if (LAG_SIMULATION) {
                setTimeout(() => {
                    this.mesh.broadcast(command.buffer);
                }, LAG_SIMULATION);
            } else {
                this.mesh.broadcast(command.buffer);
            }
        }

        this.render(this.renderGameStateIdx);
    }

    render(gameStateIdx) {
        const now = getLocalTimestamp();
        const gameState = this.gameHistory[gameStateIdx];
        // make interpolation ?
        const makeInterpolation = (MAKE_INTERPOLATION && this.gameHistory.length > gameStateIdx + 1);
        for (let [index, body] of gameState.bodies.entries()) {
            if (
                !body.isActive() /*||
                (gameStateNext && !gameStateNext.bodies[index].isActive())*/
            )
                continue;
            const phaserObject = body.getUserData();
            if (phaserObject) {
                if (makeInterpolation && phaserObject.name !== "coin") {
                    let gameStateNext = this.gameHistory[gameStateIdx + 1];
                    let bodyNext = gameStateNext.bodies[index];
                    this.interpolate(
                        phaserObject,
                        now,
                        gameState.time,
                        body.getPosition(),
                        body.getLinearVelocity(),
                        gameStateNext.time,
                        bodyNext.getPosition(),
                        bodyNext.getLinearVelocity()
                    );
                } else {
                    let bodyPosition = body.getPosition();
                    phaserObject.x = bodyPosition.x * WORLD_SCALE;
                    phaserObject.y = bodyPosition.y * WORLD_SCALE;
                }
            }
        }
        for (let [index, peer] of this.peers.entries()) {
            this.scoreTexts[index].setText(
                `${peer.username}: ${gameState.scores[index]} ${peer.disconnected ? " (disconnected)" : ""
                }`
            );
        }
    }

    interpolate(phaserObject, time, time0, pos0, vel0, time1, pos1, vel1) {
        /*
        const timeDiff = time - time0;
        phaserObject.x =
            (pos0.x + (timeDiff * (pos1.x - pos0.x)) / TIMESLICE) *
            WORLD_SCALE;
        phaserObject.y =
            (pos0.y + (timeDiff * (pos1.y - pos0.y)) / TIMESLICE) *
            WORLD_SCALE;
        //*/
        //*
        const timeDiff1 = time - time0;
        const timeDiff2 = time - time1;
        if (Math.sign(vel0.x) === Math.sign(vel1.x)) {
            // if velocity has the same sign, use position-based interpolation
            phaserObject.x =
                (pos0.x + (timeDiff1 * (pos1.x - pos0.x)) / TIMESLICE) *
                WORLD_SCALE;
        } else {
            // if the velocity is opposite, calc new position based on previous position and velocity
            if (timeDiff1 < -timeDiff2) {
                phaserObject.x = (pos0.x + vel0.x * timeDiff1 / 1000) * WORLD_SCALE;
            } else {
                phaserObject.x = (pos1.x + vel1.x * timeDiff2 / 1000) * WORLD_SCALE;
            }
        }
        if (Math.sign(vel0.y) === Math.sign(vel1.y)) {
            // if velocity has the same sign, use position-based interpolation
            phaserObject.y =
                (pos0.y + (timeDiff1 * (pos1.y - pos0.y)) / TIMESLICE) *
                WORLD_SCALE;
        } else {
            // if the velocity is opposite, calc new position based on previous position and velocity
            if (timeDiff1 < -timeDiff2) {
                phaserObject.y = (pos0.y + vel0.y * timeDiff1 / 1000) * WORLD_SCALE;
            } else {
                phaserObject.y = (pos1.y + vel1.y * timeDiff2 / 1000) * WORLD_SCALE;
            }
        }
        //*/
        // calc acceleration
/*
        const timeDiff = (time - time0) / 1000;
        const velx = vel0.x + (timeDiff * (vel1.x - vel0.x)) / (TIMESLICE / 1000) ;
        const vely = vel0.y + (timeDiff * (vel1.y - vel0.y)) / (TIMESLICE / 1000) ;
        const ax = (velx - vel0.x) / timeDiff;
        const ay = (vely - vel0.y) / timeDiff;
        const posx = pos0.x + vel0.x * timeDiff + ax * timeDiff * timeDiff / 2;
        const posy = pos0.y + vel0.y * timeDiff + ay * timeDiff * timeDiff / 2;
        phaserObject.x = posx * WORLD_SCALE;
        phaserObject.y = posy * WORLD_SCALE;
//*/
    }

    createInitialGameState() {
        const gravity = planck.Vec2(0, 0);
        const world = planck.World(gravity);

        /////////////////// BORDERS ///////////////////
        this.bottomGround = world.createBody({ type: "static" });
        this.bottomGround.createFixture(
            planck.Box(game.config.width / 2 / WORLD_SCALE, 1 / 2 / WORLD_SCALE)
        );
        this.bottomGround.setPosition(
            planck.Vec2(
                game.config.width / 2 / WORLD_SCALE,
                game.config.height / WORLD_SCALE
            )
        );

        this.topGround = world.createBody({ type: "static" });
        this.topGround.createFixture(
            planck.Box(game.config.width / 2 / WORLD_SCALE, 1 / 2 / WORLD_SCALE)
        );
        this.topGround.setPosition(
            planck.Vec2(game.config.width / 2 / WORLD_SCALE, -1 / WORLD_SCALE)
        );

        this.leftGround = world.createBody({ type: "static" });
        this.leftGround.createFixture(
            planck.Box(1 / WORLD_SCALE, game.config.height / WORLD_SCALE)
        );
        this.leftGround.setPosition(planck.Vec2(-1 / WORLD_SCALE, 0));

        this.rightGround = world.createBody({ type: "static" });
        this.rightGround.createFixture(
            planck.Box(1 / WORLD_SCALE, game.config.height / WORLD_SCALE)
        );
        this.rightGround.setPosition(
            planck.Vec2(game.config.width / WORLD_SCALE, 0)
        );

        /////////////////// CREATE PLAYERS ///////////////////
        const playerFD = {
            density: 0.0,
            restitution: 0.4
        };
        const scores = [];
        for (let [index, peer] of this.peers.entries()) {
            scores[index] = 0;
            let plyr = world.createBody({
                type: "dynamic",
                position: planck.Vec2(
                    (20 + index * 30) / WORLD_SCALE,
                    100 / WORLD_SCALE
                ),
                allowSleep: false,
                awake: true
            });
            plyr.createFixture(
                planck.Box(25 / 2 / WORLD_SCALE, 25 / 2 / WORLD_SCALE),
                playerFD
            );
            let phaserPlayer;
            if (peer.uuid === myUUID) {
                this.myIndex = index;
                this.myUsername = peer.username;
                phaserPlayer = this.add.image(20 + index * 30, 100, "player");
            } else {
                phaserPlayer = this.add.image(20 + index * 30, 100, "enemy");
            }
            plyr.setUserData(phaserPlayer);
            phaserPlayer.setName(peer.uuid);
        }

        /////////////////// CREATE COIN ///////////////////
        this.planckCoin = world.createBody({ type: "static" });
        this.planckCoin.createFixture(
            planck.Box(15 / 2 / WORLD_SCALE, 15 / 2 / WORLD_SCALE),
            { isSensor: true }
        );
        this.planckCoin.setPosition(
            planck.Vec2(250 / WORLD_SCALE, 250 / WORLD_SCALE)
        );
        this.phaserCoin = this.add.image(250, 250, "coin");
        this.phaserCoin.setName("coin");
        this.planckCoin.setUserData(this.phaserCoin);

        // return GameState
        const result = {
            slice: 0,
            time: this.timeToStart,
            world: world,
            bodies: [],
            scores: scores,
            ramdomPointer: -1,
            commands: new Array(this.peers.length)
        };
        for (let b = result.world.getBodyList(); b; b = b.getNext()) {
            result.bodies.unshift(b);
        }
        return result;
    }

    debugGameState(gameState) {
        let log = `gameState ${gameState.slice}\n  bodies\n`;
        gameState.bodies.forEach((body) => {
            if (body.getUserData())
                log += `    ${body.getUserData().name} x=${body.getPosition().x * WORLD_SCALE
                    },y=${body.getPosition().y * WORLD_SCALE}\n`;
        });
        log += "  commands:";
        gameState.commands.forEach((command) => {
            if (command) log += `${command[1]}:${command[2]} `;
        });
        log += `\n  scores: ${gameState.scores}\n`;
        log += `  ramdomPointer: ${gameState.ramdomPointer}\n`;
        log += `  coinCollected: ${gameState.coinCollected}\n`;
        console.log(log);
    }

    loadCommandsIntoGameStates() {
        let rewriteHistoryFromSlice;
        const historyLength = this.gameHistory.length;
        const firstSlice = this.gameHistory[0].slice;
        this.commandBuffer.forEach((item, index) => {
            if (item.slice >= firstSlice && item.slice < firstSlice + historyLength) {
                if (
                    item.slice < firstSlice + historyLength - 1 &&
                    (!rewriteHistoryFromSlice || rewriteHistoryFromSlice > item.slice)
                ) {
                    rewriteHistoryFromSlice = item.slice;
                }
                this.gameHistory[item.slice - firstSlice].commands[item.command[1]] =
                    item.command;
                this.commandBuffer.splice(index, 1);
            }
        });
        return rewriteHistoryFromSlice
            ? this.gameHistory[rewriteHistoryFromSlice - firstSlice]
            : null;
    }

    nextGameState(gameState, newGameState) {
        let result;
        if (newGameState) {
            result = newGameState;
            result.world = this.clone(gameState.world);
            result.bodies = [];
            result.scores = [...gameState.scores];
            result.ramdomPointer = gameState.ramdomPointer;
            result.coinCollected = undefined;
            // preserve previous commands
        } else {
            //this.debugGameState(gameState);
            result = {
                slice: gameState.slice + 1,
                time: gameState.time + TIMESLICE,
                world: this.clone(gameState.world),
                bodies: [],
                scores: [...gameState.scores],
                ramdomPointer: gameState.ramdomPointer,
                coinCollected: undefined,
                commands: new Array(this.peers.length)
            };
        }
        let planckCoin;
        for (let b = result.world.getBodyList(); b; b = b.getNext()) {
            result.bodies.unshift(b);
        }
        // hack: planck serialization does not dump userData
        for (let [index, body] of result.bodies.entries()) {
            if (body === null) continue;
            const phaserObject = gameState.bodies[index]
                ? gameState.bodies[index].getUserData()
                : null;
            if (
                index >= 4 &&
                index < this.peers.length + 4 && // remove disconnected players. ignore walls and coin
                this.peers[index - 4].disconnected
            ) {
                if (phaserObject) phaserObject.destroy();
                body.setActive(false);
                continue;
            }
            body.setUserData(phaserObject);
            if (body.getUserData() && body.getUserData().name === "coin") {
                planckCoin = body;
            }
        }
        /////////////////// COIN  ///////////////////
        if (gameState.coinCollected) {
            const index = this.peers.findIndex(
                (peer) => peer.uuid === gameState.coinCollected
            );
            if (index >= 0) {
                const peer = this.peers[index];
                result.scores[index] += 10;
                if (!newGameState) this.sound.play("success");
                const newX = this.nextRamdom(result.ramdomPointer++, 50, 450);
                const newY = this.nextRamdom(result.ramdomPointer++, 50, 450);
                planckCoin.setPosition(
                    planck.Vec2(newX / WORLD_SCALE, newY / WORLD_SCALE)
                );
            }
        }
        result.world.on("begin-contact", (contact, oldManifold) => {
            if (result.coinCollected) {
                return;
            }
            let phaserObj = contact.getFixtureB().getBody().getUserData();
            if (phaserObj && "coin" === phaserObj.name) {
                const playeWhoCollectedTheCoin = contact
                    .getFixtureA()
                    .getBody()
                    .getUserData().name;
                result.coinCollected = playeWhoCollectedTheCoin;
            }
        });

        this.computePhysics(result.world, result.bodies, gameState.commands);

        return result;
    }

    computePhysics(world, bodies, commands) {
        for (let command of commands) {
            if (!command) continue;
            const body = bodies[command[1] + 4]; // +4 to ignore the four walls
            body.applyForce(
                planck.Vec2(
                    (command[2] == 10 || command[2] == 11 || command[2] == 12
                        ? STRENGTH
                        : command[2] == 20 || command[2] == 21 || command[2] == 22
                            ? -STRENGTH
                            : 0) / WORLD_SCALE,
                    (command[2] == 1 || command[2] == 11 || command[2] == 21
                        ? STRENGTH
                        : command[2] == 2 || command[2] == 12 || command[2] == 22
                            ? -STRENGTH
                            : 0) / WORLD_SCALE
                ),
                body.getWorldCenter()
            );
        }
        world.step(TIMESLICE / 1000);
        world.clearForces();
    }

    rewriteHistory(gameState) {
        if (DEBUG.WARN)
            console.group(`rewriteHistory from gameState ${gameState.slice}`);
        if (DEBUG.GAMESTATE) this.debugGameState(gameState);
        let index = this.gameHistory.findIndex(
            (gs) => gs.slice === gameState.slice
        );
        let slice = gameState.slice;
        while (index >= 0 && index < this.gameHistory.length - 1) {
            if (DEBUG.WARN) console.log(`rewriting gameState ${++slice}`);
            const gameStateNext = this.nextGameState(
                this.gameHistory[index],
                this.gameHistory[index + 1]
            );
            if (DEBUG.GAMESTATE) this.debugGameState(gameStateNext);
            index++;
        }
        if (DEBUG.WARN) console.groupEnd();
    }

    messageReceived(uuid, message) {
        const netcommand = new Int16Array(message.body);
        switch (netcommand[0]) {
            case 0: // player keystroke
                if (DEBUG.RECEIVE)
                    console.log(
                        `message from ${uuid}: command: ${netcommand[2]}, slice=${netcommand[3]
                        }. total=${++this.messagesReceived}`
                    );
                this.commandBuffer.push({
                    slice: netcommand[3],
                    command: netcommand
                });
                break;
        }
    }

    /*
    serializeGameStates(list) {
        const result = [];
        list.forEach((item) => {
            result.push({
                slice: item.slice,
                time: item.time,
                world: this.serializer.toJson(item.world),
                scores: item.scores,
                ramdomPointer: item.ramdomPointer,
                coinCollected: item.coinCollected,
                commands: item.commands
            });
        });
        return JSON.stringify(result);
    }
  
    deserializeGameStates(json) {
        const result = JSON.parse(json);
        result.forEach((item) => {
            item.world = this.serializer.fromJson(item.world);
            item.bodies = [];
            for (let b = item.world.getBodyList(); b; b = b.getNext()) {
                item.bodies.unshift(b);
            }
            // hack: planck serialization does not dump userData
            for (let [index, body] of item.bodies.entries()) {
                body.setUserData(this.latestGameState.bodies[index].getUserData());
                //if (body.getUserData() && body.getUserData().name === "coin") {
                //    planckCoin = body;
                //}
            }
        });
        return result;
    }
  */
    nextRamdom(ramdomPointer, min, max) {
        ramdomPointer++;
        for (let i = this.ramdomValues.length; i <= ramdomPointer; i++) {
            let rnd = min + (this.ramdomGenerator.genrand_int31() % (max - min + 1));
            this.ramdomValues.push(rnd);
        }
        return this.ramdomValues[ramdomPointer];
    }
}
