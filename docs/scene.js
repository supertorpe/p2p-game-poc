
const { getLocalTimestamp } = mplaynet;

const STRENGTH = 40;
const WORLD_SCALE = 30; // Box2D works with meters. We need to convert meters to pixels. let's say 30 pixels = 1 meter.

class MainScene extends MultiplayerScene {

    constructor(peers, mesh, timeToStart) {
        super("mainScene", peers, mesh, timeToStart);
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

    sceneCreate() {
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
            phaserPlayer.interpolate = true;
            plyr.peerIndex = index;
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
            world: world,
            info: { scores: scores },
        };
        return result;
    }

    computePhysics(body, command) {
        body.applyForce(
            planck.Vec2(
                (command == 10 || command == 11 || command == 12
                    ? STRENGTH
                    : command == 20 || command == 21 || command == 22
                        ? -STRENGTH
                        : 0) / WORLD_SCALE,
                (command == 1 || command == 11 || command == 21
                    ? STRENGTH
                    : command == 2 || command == 12 || command == 22
                        ? -STRENGTH
                        : 0) / WORLD_SCALE
            ),
            body.getWorldCenter()
        );
    }

    newGameState(prevState, newState, rewritingHistory) {
        /////////////////// COIN  ///////////////////
        if (prevState.info.coinCollected) {
            const index = this.peers.findIndex(
                (peer) => peer.uuid === prevState.info.coinCollected
            );
            if (index >= 0) {
                const peer = this.peers[index];
                newState.info.scores[index] += 10;
                if (!rewritingHistory) this.sound.play("success");
                const newX = this.nextRandom(newState.randomPointer++, 50, 450);
                const newY = this.nextRandom(newState.randomPointer++, 50, 450);
                let planckCoin = this.findBodyByPhaserName(newState, "coin");
                planckCoin.setPosition(
                    planck.Vec2(newX / WORLD_SCALE, newY / WORLD_SCALE)
                );
            }
        }
        newState.world.on("begin-contact", (contact, oldManifold) => {
            if (newState.info.coinCollected) {
                return;
            }
            let phaserObj = contact.getFixtureB().getBody().getUserData();
            if (phaserObj && "coin" === phaserObj.name) {
                const playeWhoCollectedTheCoin = contact
                    .getFixtureA()
                    .getBody()
                    .getUserData().name;
                newState.info.coinCollected = playeWhoCollectedTheCoin;
            }
        });
    }

    readCommand() {
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

        return (right ? 10 : left ? 20 : 0) + (down ? 1 : up ? 2 : 0);
    }

    render(gameState) {
        for (let [index, peer] of this.peers.entries()) {
            this.scoreTexts[index].setText(
                `${peer.username}: ${gameState.info.scores[index]} ${peer.disconnected ? " (disconnected)" : ""
                }`
            );
        }
    }

    cloneGameStateInfo(info) {
        return {
            scores: [...info.scores],
            coinCollected: false
        }
    }

}
