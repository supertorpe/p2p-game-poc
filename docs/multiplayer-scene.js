const DEBUG = {
    GAMESTATE: true,
    SEND: true,
    RECEIVE: true,
    INFO: false,
    WARN: true
};

const LAG_SIMULATION = 0;
const MAKE_INTERPOLATION = true;
const TIMESLICE = 100;
const RENDER_DELAY = 2;

class MultiplayerScene extends Phaser.Scene {

    constructor(sceneName, peers, mesh, timeToStart) {
        super(sceneName);
        if (DEBUG.INFO) console.log(`getLocalTimestamp=${getLocalTimestamp()}`);
        this.randomGenerator = new MersenneTwister19937();
        this.randomGenerator.init_genrand(123456);
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
        this.randomValues = [];
        this.running = false;
        this.timeToStart = timeToStart;
        this.messagesReceived = 0;
        this.messagesSent = 0;
        this.serializer = new planck.Serializer();
    }

    create() {
        const initialGameState = this.sceneCreate();
        initialGameState.slice = 0;
        initialGameState.time = this.timeToStart;
        initialGameState.bodies = [];
        initialGameState.randomPointer = -1;
        initialGameState.commands = new Array(this.peers.length);
        for (let b = initialGameState.world.getBodyList(); b; b = b.getNext()) {
            initialGameState.bodies.unshift(b);
        }
        this.gameHistory.push(initialGameState);
        this.latestGameState = initialGameState;
        this.renderGameStateIdx = 0;
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
                        randomPointer: this.latestGameState.randomPointer,
                        commands: new Array(this.peers.length),
                        info: this.cloneGameStateInfo(this.latestGameState.info)
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
            if (DEBUG.GAMESTATE) this.debugGameState(this.latestGameState);
            this.latestGameState = this.nextGameState(
                this.gameHistory[this.gameHistory.length - 1]
            );
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

        let commandValue = this.readCommand();

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

        this.renderObjects(this.renderGameStateIdx);
    }

    renderObjects(gameStateIdx) {
        const now = getLocalTimestamp() - TIMESLICE * RENDER_DELAY;
        const gameState = this.gameHistory[gameStateIdx];
        // make interpolation ?
        const makeInterpolation = (MAKE_INTERPOLATION && this.gameHistory.length > gameStateIdx + 1);
        for (let [index, body] of gameState.bodies.entries()) {
            if (!body.isActive())
                continue;
            const phaserObject = body.getUserData();
            if (phaserObject) {
                if (makeInterpolation && phaserObject.interpolate) {
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
        this.render(gameState);
    }

    nextGameState(gameState, newGameState) {
        let result;
        if (newGameState) {
            result = newGameState;
            result.world = this.clonePlanckWorld(gameState.world);
            result.bodies = [];
            result.randomPointer = gameState.randomPointer;
            result.info = this.cloneGameStateInfo(gameState.info);
            // preserve previous commands
        } else {
            //this.debugGameState(gameState);
            result = {
                slice: gameState.slice + 1,
                time: gameState.time + TIMESLICE,
                world: this.clonePlanckWorld(gameState.world),
                bodies: [],
                randomPointer: gameState.randomPointer,
                commands: new Array(this.peers.length),
                info: this.cloneGameStateInfo(gameState.info),
            };
        }
        for (let b = result.world.getBodyList(); b; b = b.getNext()) {
            result.bodies.unshift(b);
        }
        // hack: planck serialization does not dump userData
        for (let [index, body] of result.bodies.entries()) {
            if (body === null) continue;
            const oldBody = gameState.bodies[index];
            const phaserObject = oldBody
                ? oldBody.getUserData()
                : null;
            const peerIndex = oldBody
                ? oldBody.peerIndex
                : null;
            if (peerIndex != null) { 
                body.peerIndex = peerIndex;
                if (this.peers[peerIndex].disconnected) { // remove disconnected players. ignore walls and coin
                    if (phaserObject != null) phaserObject.destroy();
                    body.setActive(false);
                    continue;
                }
            }
            body.setUserData(phaserObject);
        }

        this.newGameState(gameState, result, newGameState != null);

        for (let command of gameState.commands) {
            if (!command) continue;
            const body = result.bodies.find(body => body.peerIndex == command[1]);
            if (body) this.computePhysics(body, command[2]);
        }

        result.world.step(TIMESLICE / 1000);
        result.world.clearForces();

        return result;
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

    loadCommandsIntoGameStates() {
        let rewriteHistoryFromSlice;
        const historyLength = this.gameHistory.length;
        const firstSlice = this.gameHistory[0].slice;
        const commandBufferSize = this.commandBuffer.length;
        let removed = 0;
        for (let index = 0; index < commandBufferSize; index++) {
            let item = this.commandBuffer[index - removed];
            if (item.slice >= firstSlice && item.slice < firstSlice + historyLength) {
                if (
                    item.slice < firstSlice + historyLength - 1 &&
                    (!rewriteHistoryFromSlice || rewriteHistoryFromSlice > item.slice)
                ) {
                    rewriteHistoryFromSlice = item.slice;
                }
                this.gameHistory[item.slice - firstSlice].commands[item.command[1]] =
                    item.command;
                this.commandBuffer.splice(index - removed++, 1);
            }
        }
        return rewriteHistoryFromSlice
            ? this.gameHistory[rewriteHistoryFromSlice - firstSlice]
            : null;
    }

    findBodyByPhaserName(gameState, name) {
        return gameState.bodies.find(body => body.getUserData() && body.getUserData().name === name);
    }

    // 'abstract' methods
    sceneCreate() {
        throw new Error('sceneCreate not implemented');
    }

    newGameState() {
        throw new Error('newGameState not implemented');
    }

    computePhysics() {
        throw new Error('computePhysics not implemented');
    }

    readCommand() {
        throw new Error('readCommand not implemented');
    }

    render() {
        throw new Error('render not implemented');
    }

    cloneGameStateInfo() {
        throw new Error('cloneGameStateInfo not implemented');
    }

    // utility methods

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

    nextRandom(randomPointer, min, max) {
        randomPointer++;
        for (let i = this.randomValues.length; i <= randomPointer; i++) {
            let rnd = min + (this.randomGenerator.genrand_int31() % (max - min + 1));
            this.randomValues.push(rnd);
        }
        return this.randomValues[randomPointer];
    }

    clonePlanckWorld(world) {
        return this.serializer.fromJson(this.serializer.toJson(world));
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
        log += `  randomPointer: ${gameState.randomPointer}\n`;
        log += `\n  info: ${JSON.stringify(gameState.info)}\n`;
        console.log(log);
    }

     /*
    serializeGameStates(list) {
        const result = [];
        list.forEach((item) => {
            result.push({
                slice: item.slice,
                time: item.time,
                world: this.serializer.toJson(item.world),
                info: item.info,
                randomPointer: item.randomPointer,
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
}