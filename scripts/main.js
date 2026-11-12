
(() => {
    "use strict";

    // =====================================
    // STOCKFISH CONFIGURATION
    // =====================================

    const CONFIG = {
        movetime: 2000,
        threads: 2,
        hash: 256,
        multiPV: 1,
        skillLevel: 20,
        updateInterval: 300
    };

    let hackRunning = false;
    let engine = null;
    let engineReady = false;
    let searching = false;
    let currentFen = "";
    let pendingFen = null;
    let getPlays = null;
    let chessboard = null;

    // =====================================
    // FEN GENERATION
    // =====================================

    function getFenString() {
        let placement = "";

        for (let rank = 8; rank >= 1; rank--) {
            let empty = 0;

            for (let file = 1; file <= 8; file++) {
                const square = `${file}${rank}`;

                const piece = document.querySelector(
                    `.piece.square-${square}`
                );

                if (!piece) {
                    empty++;
                    continue;
                }

                if (empty > 0) {
                    placement += empty;
                    empty = 0;
                }

                const pieceClass = [...piece.classList].find(
                    c => /^[wb][pnbrqk]$/i.test(c)
                );

                if (!pieceClass) continue;

                const color = pieceClass[0];
                const type = pieceClass[1];

                placement += color === "w"
                    ? type.toUpperCase()
                    : type.toLowerCase();
            }

            if (empty > 0) {
                placement += empty;
            }

            if (rank > 1) {
                placement += "/";
            }
        }

        const playerColor = chessboard.classList.contains("flipped")
            ? "b"
            : "w";

        // Castling and en-passant rights are not available
        // from the board layout alone.
        return `${placement} ${playerColor} - - 0 1`;
    }

    // =====================================
    // HIGHLIGHT MANAGEMENT
    // =====================================

    function clearHighlights() {
        document.querySelectorAll(".cheat-highlight").forEach(element => {
            element.remove();
        });
    }

    function highlightMove(move) {
        clearHighlights();

        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
            return;
        }

        const files = {
            a: 1, b: 2, c: 3, d: 4,
            e: 5, f: 6, g: 7, h: 8
        };

        const from = `${files[move[0]]}${move[1]}`;
        const to = `${files[move[2]]}${move[3]}`;

        const start = document.createElement("div");
        start.className = `highlight cheat-highlight square-${from}`;

        start.style.cssText = `
            background: rgba(255, 0, 0, 0.15);
            pointer-events: none;
        `;

        const destination = document.createElement("div");
        destination.className = `highlight cheat-highlight square-${to}`;

        destination.style.cssText = `
            background: rgba(255, 0, 0, 0.15);
            pointer-events: none;
        `;

        chessboard.appendChild(start);
        chessboard.appendChild(destination);
    }

    // =====================================
    // STOCKFISH INITIALIZATION
    // =====================================

    function createEngine() {
        if (engine) return;

        engine = new Worker(
            "/bundles/app/js/vendor/jschessengine/stockfish.asm.1abfa10c.js"
        );

        engine.onerror = () => {
            console.error("Stockfish worker error");
            stopHack();
        };

        engine.onmessage = event => {
            const message = String(event.data);

            // UCI handshake
            if (message === "uciok") {
                engine.postMessage(
                    `setoption name Threads value ${CONFIG.threads}`
                );

                engine.postMessage(
                    `setoption name Hash value ${CONFIG.hash}`
                );

                engine.postMessage(
                    `setoption name MultiPV value ${CONFIG.multiPV}`
                );

                engine.postMessage(
                    `setoption name Skill Level value ${CONFIG.skillLevel}`
                );

                engine.postMessage(
                    "setoption name UCI_AnalyseMode value true"
                );

                engine.postMessage("isready");
            }

            // Engine ready
            if (message === "readyok") {
                engineReady = true;

                console.log("Stockfish ready");

                if (pendingFen) {
                    const fen = pendingFen;
                    pendingFen = null;
                    startAnalysis(fen);
                }
            }

            // Search information
            if (message.startsWith("info ")) {
                console.log(message);
            }

            // Best move received
            if (message.startsWith("bestmove ")) {
                searching = false;

                const bestMove = message.split(" ")[1];

                console.log("Best move:", bestMove);

                if (bestMove && bestMove !== "(none)" &&
                    bestMove !== "0000") {
                    highlightMove(bestMove);
                }

                // Start the newest pending position
                if (pendingFen && hackRunning) {
                    const fen = pendingFen;
                    pendingFen = null;
                    startAnalysis(fen);
                }
            }
        };

        engine.postMessage("uci");
    }

    // =====================================
    // ANALYSIS
    // =====================================

    function startAnalysis(fen) {
        if (!engine || !engineReady || !hackRunning) return;

        if (searching) {
            pendingFen = fen;
            engine.postMessage("stop");
            return;
        }

        searching = true;
        currentFen = fen;

        clearHighlights();

        engine.postMessage(`position fen ${fen}`);

        // Exactly 5 seconds of analysis
        engine.postMessage(
            `go movetime ${CONFIG.movetime}`
        );

        console.log("Analyzing:", fen);
    }

    // =====================================
    // BOARD MONITORING
    // =====================================

    function monitorBoard() {
        getPlays = setInterval(() => {
            if (!hackRunning) return;

            const newFen = getFenString();

            if (newFen !== currentFen && newFen !== pendingFen) {
                if (searching) {
                    pendingFen = newFen;
                    engine.postMessage("stop");
                } else if (engineReady) {
                    startAnalysis(newFen);
                } else {
                    pendingFen = newFen;
                }
            }
        }, CONFIG.updateInterval);
    }

    // =====================================
    // START
    // =====================================

    function startHack() {
        if (hackRunning) return;

        chessboard = document.querySelector("wc-chess-board");

        if (!chessboard) {
            alert("Schachbrett wurde nicht gefunden.");
            return;
        }

        hackRunning = true;
        currentFen = "";
        pendingFen = getFenString();

        button.textContent = "Analyse läuft ...";

        createEngine();
        monitorBoard();
    }

    // =====================================
    // STOP
    // =====================================

    function stopHack() {
        hackRunning = false;
        engineReady = false;
        searching = false;
        currentFen = "";
        pendingFen = null;

        if (getPlays) {
            clearInterval(getPlays);
            getPlays = null;
        }

        if (engine) {
            engine.postMessage("stop");
            engine.postMessage("quit");
            engine.terminate();
            engine = null;
        }

        clearHighlights();

        button.textContent = "Chess";

        console.log("Stockfish stopped");
    }

    // =====================================
    // BUTTON
    // =====================================
   const button = document.createElement("button");

    button.id = "hack_button";
    button.className =
        "ui_v5-button-component ui_v5-button-primary";

    button.textContent = "";

    button.style.cssText = `
        width: 5%;
        min-width: 10px;
        height: 5%;
        min-height: 10px;
        padding: 0;
        margin: 0 auto;
        display: block;
        font-size: 0;
        opacity: 0.04;
        border: none;
        box-shadow: none;
    `;

    button.addEventListener("click", () => {
        if (hackRunning) {
            stopHack();
        } else {
            startHack();
        }
    });

    // =====================================
    // INSERT INTO PAGE
    // =====================================

    const mainBody = document.querySelector(".board-layout-main");

    if (mainBody) {
        mainBody.prepend(button);
    } else {
        console.error("Main page container not found");
    }

})();
