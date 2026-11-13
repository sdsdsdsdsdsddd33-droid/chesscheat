
(() => {
    "use strict";

    // =====================================
    // CONFIGURATION
    // =====================================

    const CONFIG = {
        movetime: 2000,
        threads: 2,
        hash: 256,
        multiPV: 1,
        skillLevel: 20,
        updateInterval: 300
    };

    const STOCKFISH_PATH =
        "/bundles/app/js/vendor/jschessengine/stockfish.asm.1abfa10c.js";

    const START_FEN =
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    let hackRunning = false;
    let engine = null;
    let engineReady = false;
    let searching = false;

    let currentFen = "";
    let pendingFen = null;

    let monitorTimer = null;
    let chessboard = null;

    // =====================================
    // CHESS POSITION HELPERS
    // =====================================

    function squareIndex(square) {
        if (!/^[a-h][1-8]$/.test(square)) return -1;

        const file = square.charCodeAt(0) - 97;
        const rank = Number(square[1]);

        return (8 - rank) * 8 + file;
    }

    function indexSquare(index) {
        const file = index % 8;
        const rank = 8 - Math.floor(index / 8);

        return String.fromCharCode(97 + file) + rank;
    }

    function validIndex(index) {
        return index >= 0 && index < 64;
    }

    function parseStartingPosition(fen) {
        const fields = fen.trim().split(/\s+/);
        const rows = fields[0].split("/");

        if (rows.length !== 8) {
            throw new Error("Invalid starting position.");
        }

        const board = Array(64).fill(".");

        rows.forEach((row, rank) => {
            let file = 0;

            for (const char of row) {
                if (/^[1-8]$/.test(char)) {
                    file += Number(char);
                } else {
                    if (!/^[pnbrqkPNBRQK]$/.test(char)) {
                        throw new Error("Invalid chess piece.");
                    }

                    if (file >= 8) {
                        throw new Error("Invalid FEN rank.");
                    }

                    board[rank * 8 + file] = char;
                    file++;
                }
            }

            if (file !== 8) {
                throw new Error("Invalid FEN rank.");
            }
        });

        return {
            board,
            turn: fields[1],
            castling: fields[2],
            ep: fields[3],
            halfmove: Number(fields[4]),
            fullmove: Number(fields[5])
        };
    }

    // =====================================
    // UCI MOVE EXTRACTION
    // =====================================

    function extractUci(entry) {
        if (typeof entry === "string") {
            const match = entry.match(
                /(?:^|\s)([a-h][1-8][a-h][1-8][qrbn]?)(?:\s|$)/i
            );

            return match ? match[1].toLowerCase() : null;
        }

        if (!entry || typeof entry !== "object") {
            return null;
        }

        const candidates = [
            entry.uci,
            entry.move?.uci,
            entry.move?.coordinate,
            entry.coordinate,
            entry.notation?.uci
        ];

        for (const candidate of candidates) {
            if (
                typeof candidate === "string" &&
                /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(candidate)
            ) {
                return candidate.toLowerCase();
            }
        }

        return null;
    }

    function getGameObject() {
        if (!chessboard) return null;

        try {
            if (chessboard.game) {
                return chessboard.game;
            }

            if (chessboard._game) {
                return chessboard._game;
            }
        } catch (error) {
            console.warn("Could not access Chess.com game object.", error);
        }

        return null;
    }

    function getMoveHistory() {
        const game = getGameObject();

        if (!game) return null;

        const sources = [];

        try {
            if (typeof game.getLog === "function") {
                sources.push(game.getLog());
            }
        } catch (_) {}

        try {
            if (Array.isArray(game.log)) {
                sources.push(game.log);
            }
        } catch (_) {}

        try {
            if (typeof game.getHistory === "function") {
                sources.push(game.getHistory());
            }
        } catch (_) {}

        try {
            if (typeof game.getMoveHistory === "function") {
                sources.push(game.getMoveHistory());
            }
        } catch (_) {}

        for (const source of sources) {
            if (!Array.isArray(source)) continue;

            const moves = [];

            let valid = true;

            for (const entry of source) {
                const move = extractUci(entry);

                if (!move) {
                    valid = false;
                    break;
                }

                moves.push(move);
            }

            if (valid) {
                return moves;
            }
        }

        return null;
    }

    // =====================================
    // REPLAY CHESS HISTORY
    // =====================================

    function updateCastlingRights(position, piece, from, to, captured) {
        let rights = position.castling;

        const remove = value => {
            rights = rights.replace(value, "");
        };

        // King moves
        if (piece === "K") {
            remove("K");
            remove("Q");
        }

        if (piece === "k") {
            remove("k");
            remove("q");
        }

        // White rooks
        if (piece === "R" && from === "h1") remove("K");
        if (piece === "R" && from === "a1") remove("Q");

        // Black rooks
        if (piece === "r" && from === "h8") remove("k");
        if (piece === "r" && from === "a8") remove("q");

        // Captured rooks
        if (captured === "R" && to === "h1") remove("K");
        if (captured === "R" && to === "a1") remove("Q");

        if (captured === "r" && to === "h8") remove("k");
        if (captured === "r" && to === "a8") remove("q");

        position.castling = rights || "-";
    }

    function applyUciMove(position, uci) {
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uci)) {
            throw new Error("Invalid UCI move: " + uci);
        }

        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);

        const promotion = uci[4]?.toLowerCase() || null;

        const fromIndex = squareIndex(from);
        const toIndex = squareIndex(to);

        if (!validIndex(fromIndex) || !validIndex(toIndex)) {
            throw new Error("Invalid square.");
        }

        const board = position.board;

        const piece = board[fromIndex];

        if (piece === ".") {
            throw new Error("Missing piece at " + from);
        }

        const whiteMove = position.turn === "w";

        const isWhitePiece = piece === piece.toUpperCase();

        if (whiteMove !== isWhitePiece) {
            throw new Error("Wrong side to move.");
        }

        const captured = board[toIndex];

        const isPawn = piece.toLowerCase() === "p";

        const isKing = piece.toLowerCase() === "k";

        const oldEp = position.ep;

        // Update castling rights BEFORE moving pieces
        updateCastlingRights(
            position,
            piece,
            from,
            to,
            captured
        );

        // En passant
        let enPassantCapture = false;

        if (
            isPawn &&
            to === oldEp &&
            captured === "."
        ) {
            const capturedIndex = toIndex + (whiteMove ? 8 : -8);

            if (
                validIndex(capturedIndex) &&
                board[capturedIndex].toLowerCase() === "p"
            ) {
                board[capturedIndex] = ".";
                enPassantCapture = true;
            }
        }

        // Castling
        if (isKing && Math.abs(toIndex - fromIndex) === 2) {
            if (toIndex > fromIndex) {
                const rookFrom = fromIndex + 3;
                const rookTo = fromIndex + 1;

                board[rookTo] = board[rookFrom];
                board[rookFrom] = ".";
            } else {
                const rookFrom = fromIndex - 4;
                const rookTo = fromIndex - 1;

                board[rookTo] = board[rookFrom];
                board[rookFrom] = ".";
            }
        }

        // Move piece
        board[fromIndex] = ".";

        if (promotion && isPawn) {
            board[toIndex] = whiteMove
                ? promotion.toUpperCase()
                : promotion;
        } else {
            board[toIndex] = piece;
        }

        // En passant target
        position.ep = "-";

        if (isPawn && Math.abs(toIndex - fromIndex) === 16) {
            position.ep = indexSquare(
                (fromIndex + toIndex) / 2
            );
        }

        // Halfmove clock
        if (isPawn || captured !== "." || enPassantCapture) {
            position.halfmove = 0;
        } else {
            position.halfmove++;
        }

        // Fullmove counter
        if (!whiteMove) {
            position.fullmove++;
        }

        // Switch player
        position.turn = whiteMove ? "b" : "w";
    }

    // =====================================
    // BUILD COMPLETE FEN
    // =====================================

    function createFen(position) {
        let placement = "";

        for (let rank = 0; rank < 8; rank++) {
            let empty = 0;

            for (let file = 0; file < 8; file++) {
                const piece = position.board[rank * 8 + file];

                if (piece === ".") {
                    empty++;
                    continue;
                }

                if (empty > 0) {
                    placement += empty;
                    empty = 0;
                }

                placement += piece;
            }

            if (empty > 0) {
                placement += empty;
            }

            if (rank !== 7) {
                placement += "/";
            }
        }

        return [
            placement,
            position.turn,
            position.castling,
            position.ep,
            position.halfmove,
            position.fullmove
        ].join(" ");
    }

    // =====================================
    // READ CURRENT FEN
    // =====================================

    function getNativeFen() {
        const game = getGameObject();

        const candidates = [];

        try {
            if (game && typeof game.getFen === "function") {
                candidates.push(game.getFen());
            }
        } catch (_) {}

        try {
            if (game && typeof game.fen === "string") {
                candidates.push(game.fen);
            }
        } catch (_) {}

        try {
            candidates.push(chessboard.getAttribute("fen"));
        } catch (_) {}

        try {
            const element = document.querySelector("[data-fen]");

            if (element) {
                candidates.push(element.getAttribute("data-fen"));
            }
        } catch (_) {}

        for (const fen of candidates) {
            if (typeof fen !== "string") continue;

            const fields = fen.trim().split(/\s+/);

            if (
                fields.length === 6 &&
                /^[rnbqkp1-8/]+$/.test(fields[0]) &&
                /^[wb]$/.test(fields[1]) &&
                /^(?:-|K?Q?k?q?)$/.test(fields[2]) &&
                /^(?:-|[a-h][36])$/.test(fields[3])
            ) {
                return fen.trim();
            }
        }

        return null;
    }

    function getFenString() {
        // Method 1: Complete FEN directly from Chess.com
        const nativeFen = getNativeFen();

        if (nativeFen) {
            return nativeFen;
        }

        // Method 2: Reconstruct from complete move history
        const moves = getMoveHistory();

        if (!moves) {
            return null;
        }

        try {
            const position = parseStartingPosition(START_FEN);

            for (const move of moves) {
                applyUciMove(position, move);
            }

            return createFen(position);

        } catch (error) {
            console.error("Could not reconstruct chess position:", error);
            return null;
        }
    }

    // =====================================
    // HIGHLIGHT MANAGEMENT
    // =====================================

    function clearHighlights() {
        if (!chessboard) return;

        chessboard.querySelectorAll(".cheat-highlight").forEach(element => {
            element.remove();
        });
    }

    function highlightMove(move) {
        clearHighlights();

        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(move)) {
            return;
        }

        const from = move.slice(0, 2);
        const to = move.slice(2, 4);

        const fromIndex = squareIndex(from);
        const toIndex = squareIndex(to);

        if (fromIndex < 0 || toIndex < 0) return;

        const files = {
            a: 1,
            b: 2,
            c: 3,
            d: 4,
            e: 5,
            f: 6,
            g: 7,
            h: 8
        };

        const startSquare =
            `${files[from[0]]}${from[1]}`;

        const destinationSquare =
            `${files[to[0]]}${to[1]}`;

        const start = document.createElement("div");

        start.className =
            `highlight cheat-highlight square-${startSquare}`;

        start.style.cssText = `
            background: rgba(255, 0, 0, 0.15);
            pointer-events: none;
        `;

        const destination = document.createElement("div");

        destination.className =
            `highlight cheat-highlight square-${destinationSquare}`;

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

        try {
            engine = new Worker(STOCKFISH_PATH);
        } catch (error) {
            console.error("Could not create Stockfish worker:", error);
            stopHack();
            return;
        }

        engine.onerror = error => {
            console.error("Stockfish worker error:", error);
            stopHack();
        };

        engine.onmessage = event => {
            if (!hackRunning || !engine) return;

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
                return;
            }

            // Engine ready
            if (message === "readyok") {
                engineReady = true;

                console.log("Stockfish ready.");

                if (pendingFen) {
                    const fen = pendingFen;
                    pendingFen = null;

                    startAnalysis(fen);
                }

                return;
            }

            // Analysis information
            if (message.startsWith("info ")) {
                return;
            }

            // Best move
            if (message.startsWith("bestmove ")) {
                searching = false;

                const bestMove = message.split(/\s+/)[1];

                console.log("Stockfish best move:", bestMove);

                if (
                    bestMove &&
                    bestMove !== "(none)" &&
                    bestMove !== "0000"
                ) {
                    highlightMove(bestMove);
                }

                // Analyze latest position
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
        if (!engine || !engineReady || !hackRunning) {
            return;
        }

        if (searching) {
            pendingFen = fen;
            engine.postMessage("stop");
            return;
        }

        searching = true;
        currentFen = fen;

        clearHighlights();

        engine.postMessage(`position fen ${fen}`);

        engine.postMessage(
            `go movetime ${CONFIG.movetime}`
        );

        console.log("Analyzing position:", fen);
    }

    // =====================================
    // BOARD MONITORING
    // =====================================

    function monitorBoard() {
        if (monitorTimer) {
            clearInterval(monitorTimer);
        }

        monitorTimer = setInterval(() => {
            if (!hackRunning) return;

            const newFen = getFenString();

            if (!newFen) {
                return;
            }

            if (
                newFen === currentFen &&
                newFen === pendingFen
            ) {
                return;
            }

            if (newFen === currentFen && !pendingFen) {
                return;
            }

            if (newFen === pendingFen) {
                return;
            }

            if (searching) {
                pendingFen = newFen;
                engine.postMessage("stop");
            } else if (engineReady) {
                startAnalysis(newFen);
            } else {
                pendingFen = newFen;
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
        pendingFen = null;

        button.textContent = "Analyse läuft ...";

        createEngine();

        if (!engine) {
            stopHack();
            return;
        }

        monitorBoard();

        // Initial position
        const initialFen = getFenString();

        if (initialFen) {
            pendingFen = initialFen;

            if (engineReady) {
                pendingFen = null;
                startAnalysis(initialFen);
            }
        }

        console.log("Chess analysis started.");
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

        if (monitorTimer) {
            clearInterval(monitorTimer);
            monitorTimer = null;
        }

        if (engine) {
            try {
                engine.postMessage("stop");
                engine.postMessage("quit");
                engine.terminate();
            } catch (_) {}

            engine = null;
        }

        clearHighlights();

        button.textContent = "Chess";

        console.log("Stockfish stopped.");
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

    function insertButton() {
        const mainBody = document.querySelector(
            ".board-layout-main"
        );

        if (!mainBody) {
            console.error("Main page container not found.");
            return;
        }

        if (!button.isConnected) {
            mainBody.prepend(button);
        }
    }

    insertButton();

})();

