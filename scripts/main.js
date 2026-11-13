

(() => {
    "use strict";

    // =====================================
    // CONFIGURATION
    // =====================================

    const CONFIG = {
        movetime: 2000,
        threads: 2,
        hash: 256,
        multiPV: 3,
        skillLevel: 20,
        updateInterval: 300,

        enginePath:
            "/bundles/app/js/vendor/jschessengine/stockfish.asm.1abfa10c.js"
    };

    let engine = null;
    let engineReady = false;
    let searching = false;
    let analysisRunning = false;
    let currentFen = "";
    let pendingFen = null;
    let interval = null;

    // =====================================
    // CHESS STATE
    // =====================================

    const START_FEN =
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    const files = "abcdefgh";

    const glyph = {
        K: "♔", Q: "♕", R: "♖",
        B: "♗", N: "♘", P: "♙",
        k: "♚", q: "♛", r: "♜",
        b: "♝", n: "♞", p: "♟"
    };

    let game = {
        fen: START_FEN,
        history: [],
        moves: [],
        status: "Bereit"
    };

    // =====================================
    // FEN PARSER
    // =====================================

    function parseFen(fen) {
        const parts = fen.split(/\s+/);
        const rows = parts[0].split("/");

        if (rows.length !== 8) {
            throw new Error("Ungültige FEN.");
        }

        const board = Array(128).fill(null);

        rows.forEach((row, rank) => {
            let file = 0;

            for (const char of row) {
                if (/[1-8]/.test(char)) {
                    file += Number(char);
                } else {
                    if (!/[prnbqkPRNBQK]/.test(char) || file >= 8) {
                        throw new Error("Ungültige Figurenstellung.");
                    }

                    board[rank * 16 + file] = char;
                    file++;
                }
            }

            if (file !== 8) {
                throw new Error("Ungültige Brettreihe.");
            }
        });

        return {
            board,
            turn: parts[1],
            castling: parts[2],
            ep: parts[3],
            halfmove: Number(parts[4] || 0),
            fullmove: Number(parts[5] || 1)
        };
    }

    // =====================================
    // FEN GENERATOR
    // =====================================

    function generateFen(state) {
        let placement = "";

        for (let rank = 0; rank < 8; rank++) {
            let empty = 0;

            for (let file = 0; file < 8; file++) {
                const piece = state.board[rank * 16 + file];

                if (!piece) {
                    empty++;
                } else {
                    if (empty) {
                        placement += empty;
                        empty = 0;
                    }

                    placement += piece;
                }
            }

            if (empty) placement += empty;
            if (rank !== 7) placement += "/";
        }

        return [
            placement,
            state.turn,
            state.castling || "-",
            state.ep || "-",
            state.halfmove,
            state.fullmove
        ].join(" ");
    }

    // =====================================
    // MOVE VALIDATION HELPERS
    // =====================================

    function square(file, rank) {
        return rank * 16 + file;
    }

    function validSquare(pos) {
        return pos >= 0 && pos < 128 && !(pos & 0x88);
    }

    function color(piece) {
        if (!piece) return null;
        return piece === piece.toUpperCase() ? "w" : "b";
    }

    function positionName(pos) {
        return files[pos & 7] + (8 - (pos >> 4));
    }

    function findKing(state, side) {
        const king = side === "w" ? "K" : "k";

        return state.board.findIndex(piece => piece === king);
    }

    // =====================================
    // ATTACK DETECTION
    // =====================================

    function isAttacked(state, target, attacker) {
        for (let from = 0; from < 128; from++) {
            if (!validSquare(from)) {
                from += 7;
                continue;
            }

            const piece = state.board[from];

            if (!piece || color(piece) !== attacker) continue;

            const type = piece.toLowerCase();
            const df = (target & 7) - (from & 7);
            const dr = (target >> 4) - (from >> 4);

            if (type === "p") {
                const direction = attacker === "w" ? -1 : 1;

                if (
                    dr === direction &&
                    Math.abs(df) === 1
                ) return true;

                continue;
            }

            if (type === "n") {
                if (
                    (Math.abs(df) === 1 && Math.abs(dr) === 2) ||
                    (Math.abs(df) === 2 && Math.abs(dr) === 1)
                ) return true;

                continue;
            }

            if (type === "k") {
                if (
                    Math.max(Math.abs(df), Math.abs(dr)) === 1
                ) return true;

                continue;
            }

            const diagonal = Math.abs(df) === Math.abs(dr);
            const straight = df === 0 || dr === 0;

            if (
                (type === "b" && !diagonal) ||
                (type === "r" && !straight) ||
                (type === "q" && !diagonal && !straight)
            ) continue;

            const stepFile = Math.sign(df);
            const stepRank = Math.sign(dr);

            let f = (from & 7) + stepFile;
            let r = (from >> 4) + stepRank;

            while (f >= 0 && f < 8 && r >= 0 && r < 8) {
                const pos = square(f, r);

                if (pos === target) return true;
                if (state.board[pos]) break;

                f += stepFile;
                r += stepRank;
            }
        }

        return false;
    }

    function inCheck(state, side = state.turn) {
        const king = findKing(state, side);

        if (king < 0) return false;

        return isAttacked(
            state,
            king,
            side === "w" ? "b" : "w"
        );
    }

    // =====================================
    // APPLY MOVE
    // =====================================

    function applyMove(state, move) {
        const next = {
            ...state,
            board: state.board.slice()
        };

        const piece = next.board[move.from];
        const captured = next.board[move.to];

        next.board[move.from] = null;
        next.board[move.to] =
            move.promotion
                ? state.turn === "w"
                    ? move.promotion.toUpperCase()
                    : move.promotion
                : piece;

        // EN PASSANT
        if (move.enPassant) {
            const capturedSquare =
                move.to + (state.turn === "w" ? 16 : -16);

            next.board[capturedSquare] = null;
        }

        // CASTLING
        if (move.castle) {
            const kingSide = move.to > move.from;

            const rookFrom = kingSide
                ? move.from + 3
                : move.from - 4;

            const rookTo = kingSide
                ? move.from + 1
                : move.from - 1;

            next.board[rookTo] = next.board[rookFrom];
            next.board[rookFrom] = null;
        }

        // CASTLING RIGHTS
        let rights = next.castling === "-"
            ? ""
            : next.castling;

        if (piece === "K") rights = rights.replace(/[KQ]/g, "");
        if (piece === "k") rights = rights.replace(/[kq]/g, "");

        const rookRights = {
            112: "Q",
            119: "K",
            0: "q",
            7: "k"
        };

        if (piece.toLowerCase() === "r") {
            rights = rights.replace(rookRights[move.from] || "", "");
        }

        if (captured && captured.toLowerCase() === "r") {
            rights = rights.replace(rookRights[move.to] || "", "");
        }

        next.castling = rights || "-";

        // EN PASSANT TARGET
        next.ep = move.doublePawn
            ? positionName((move.from + move.to) / 2)
            : "-";

        next.halfmove =
            piece.toLowerCase() === "p" || captured
                ? 0
                : next.halfmove + 1;

        if (state.turn === "b") {
            next.fullmove++;
        }

        next.turn = state.turn === "w" ? "b" : "w";

        return next;
    }

    // =====================================
    // LEGAL MOVE GENERATION
    // =====================================

    function pseudoMoves(state) {
        const moves = [];

        const directions = {
            n: [-33, -31, -18, -14, 14, 18, 31, 33],
            b: [-17, -15, 15, 17],
            r: [-16, -1, 1, 16],
            q: [-17, -15, -16, -1, 1, 15, 16, 17],
            k: [-17, -15, -16, -1, 1, 15, 16, 17]
        };

        function add(from, to, extra = {}) {
            const captured = state.board[to];

            if (captured && captured.toLowerCase() === "k") return;

            const piece = state.board[from];

            if (
                piece.toLowerCase() === "p" &&
                (to >> 4 === 0 || to >> 4 === 7)
            ) {
                for (const promotion of ["q", "r", "b", "n"]) {
                    moves.push({
                        from,
                        to,
                        promotion,
                        ...extra
                    });
                }
            } else {
                moves.push({ from, to, ...extra });
            }
        }

        for (let from = 0; from < 128; from++) {
            if (!validSquare(from)) {
                from += 7;
                continue;
            }

            const piece = state.board[from];

            if (!piece || color(piece) !== state.turn) continue;

            const type = piece.toLowerCase();

            if (type === "p") {
                const direction = state.turn === "w" ? -16 : 16;
                const one = from + direction;

                if (validSquare(one) && !state.board[one]) {
                    add(from, one);

                    const startRank = state.turn === "w" ? 6 : 1;
                    const two = from + direction * 2;

                    if (
                        (from >> 4) === startRank &&
                        !state.board[two]
                    ) {
                        add(from, two, { doublePawn: true });
                    }
                }

                for (const offset of [-1, 1]) {
                    const to = one + offset;

                    if (!validSquare(to)) continue;

                    if (
                        state.board[to] &&
                        color(state.board[to]) !== state.turn
                    ) {
                        add(from, to);
                    }

                    if (
                        positionName(to) === state.ep &&
                        !state.board[to]
                    ) {
                        add(from, to, { enPassant: true });
                    }
                }

                continue;
            }

            for (const direction of directions[type]) {
                let to = from + direction;

                while (validSquare(to)) {
                    if (state.board[to] && color(state.board[to]) === state.turn) {
                        break;
                    }

                    add(from, to);

                    if (
                        state.board[to] ||
                        type === "n" ||
                        type === "k"
                    ) break;

                    to += direction;
                }
            }
        }

        // CASTLING
        const kingStart = state.turn === "w" ? 116 : 4;
        const enemy = state.turn === "w" ? "b" : "w";
        const king = state.turn === "w" ? "K" : "k";
        const rook = state.turn === "w" ? "R" : "r";

        if (
            state.board[kingStart] === king &&
            !inCheck(state)
        ) {
            const kingRight = state.turn === "w" ? "K" : "k";
            const queenRight = state.turn === "w" ? "Q" : "q";

            if (
                state.castling.includes(kingRight) &&
                state.board[kingStart + 3] === rook &&
                !state.board[kingStart + 1] &&
                !state.board[kingStart + 2] &&
                !isAttacked(state, kingStart + 1, enemy) &&
                !isAttacked(state, kingStart + 2, enemy)
            ) {
                moves.push({
                    from: kingStart,
                    to: kingStart + 2,
                    castle: true
                });
            }

            if (
                state.castling.includes(queenRight) &&
                state.board[kingStart - 4] === rook &&
                !state.board[kingStart - 1] &&
                !state.board[kingStart - 2] &&
                !state.board[kingStart - 3] &&
                !isAttacked(state, kingStart - 1, enemy) &&
                !isAttacked(state, kingStart - 2, enemy)
            ) {
                moves.push({
                    from: kingStart,
                    to: kingStart - 2,
                    castle: true
                });
            }
        }

        return moves;
    }

    function legalMoves(state) {
        return pseudoMoves(state).filter(move => {
            const next = applyMove(state, move);

            return !inCheck(next, state.turn);
        });
    }

    // =====================================
    // GAME STATUS
    // =====================================

    function getStatus(state) {
        const moves = legalMoves(state);
        const check = inCheck(state);

        if (!moves.length) {
            return check
                ? "Schachmatt"
                : "Patt";
        }

        if (check) return "Schach";

        return "Spiel läuft";
    }

    // =====================================
    // MOVE NOTATION
    // =====================================

    function moveName(move) {
        if (move.castle) {
            return move.to > move.from ? "O-O" : "O-O-O";
        }

        let name =
            positionName(move.from) +
            positionName(move.to);

        if (move.enPassant) name += " e.p.";

        if (move.promotion) {
            name += "=" + move.promotion.toUpperCase();
        }

        return name;
    }

    // =====================================
    // ENGINE
    // =====================================

    function createEngine() {
        if (engine) return;

        engine = new Worker(CONFIG.enginePath);

        engine.onerror = error => {
            console.error("Stockfish error:", error);
            stopAnalysis();
        };

        engine.onmessage = event => {
            const message = String(event.data);

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

                engine.postMessage("isready");
            }

            if (message === "readyok") {
                engineReady = true;

                if (pendingFen && analysisRunning) {
                    const fen = pendingFen;
                    pendingFen = null;
                    analyze(fen);
                }
            }

            if (message.startsWith("info ")) {
                displayInfo(message);
            }

            if (message.startsWith("bestmove ")) {
                searching = false;

                const bestMove = message.split(" ")[1];

                console.log("Stockfish best move:", bestMove);

                if (pendingFen && analysisRunning) {
                    const fen = pendingFen;
                    pendingFen = null;
                    analyze(fen);
                }
            }
        };

        engine.postMessage("uci");
    }

    // =====================================
    // ANALYSIS DISPLAY
    // =====================================

    function displayInfo(message) {
        const depth = message.match(/\bdepth (\d+)/);
        const score = message.match(/\bscore cp (-?\d+)/);
        const mate = message.match(/\bscore mate (-?\d+)/);
        const pv = message.match(/\bpv (.+)$/);

        if (!depth) return;

        const panel = document.getElementById("chess-analysis-info");

        if (!panel) return;

        const lines = [];

        if (score) {
            lines.push(
                "Bewertung: " +
                (Number(score[1]) / 100).toFixed(2)
            );
        }

        if (mate) {
            lines.push("Matt in " + mate[1]);
        }

        if (pv) {
            lines.push("Variante: " + pv[1]);
        }

        panel.textContent =
            "Tiefe: " + depth[1] + " | " + lines.join(" | ");
    }

    // =====================================
    // START ANALYSIS
    // =====================================

    function analyze(fen) {
        if (!engine || !engineReady || !analysisRunning) return;

        if (searching) {
            pendingFen = fen;
            engine.postMessage("stop");
            return;
        }

        searching = true;
        currentFen = fen;

        engine.postMessage("position fen " + fen);
        engine.postMessage("go movetime " + CONFIG.movetime);
    }

    // =====================================
    // ANALYSIS PANEL
    // =====================================

    function createPanel() {
        let panel = document.getElementById("chess-analysis-info");

        if (panel) return panel;

        panel = document.createElement("div");
        panel.id = "chess-analysis-info";

        panel.style.cssText = `
            padding: 8px;
            margin: 8px auto;
            background: rgba(30,30,30,0.9);
            color: white;
            font-size: 12px;
            border-radius: 5px;
            text-align: center;
            max-width: 500px;
        `;

        panel.textContent = "Analyse bereit";

        return panel;
    }

    // =====================================
    // LOCAL GAME TEST
    // =====================================

    function startTestGame() {
        const state = parseFen(START_FEN);

        game = {
            fen: generateFen(state),
            history: [START_FEN],
            moves: [],
            status: "Spiel läuft"
        };

        console.log("Test game started:", game);
    }

    function playTestMove(uci) {
        const state = parseFen(game.fen);

        const moves = legalMoves(state);

        const move = moves.find(candidate =>
            positionName(candidate.from) +
            positionName(candidate.to) +
            (candidate.promotion || "") === uci
        );

        if (!move) {
            console.warn("Illegal move:", uci);
            return false;
        }

        const next = applyMove(state, move);

        game.moves.push(moveName(move));
        game.fen = generateFen(next);
        game.history.push(game.fen);
        game.status = getStatus(next);

        console.log("Move:", moveName(move));
        console.log("Position:", game.fen);
        console.log("Status:", game.status);

        return true;
    }

    // =====================================
    // START / STOP
    // =====================================

    function startAnalysis() {
        if (analysisRunning) return;

        analysisRunning = true;

        button.textContent = "Analyse läuft ...";

        createPanel();

        const container =
            document.querySelector(".board-layout-main");

        if (container) {
            container.prepend(createPanel());
        }

        createEngine();

        startTestGame();

        console.log("Chess analysis initialized");
    }

    function stopAnalysis() {
        analysisRunning = false;
        engineReady = false;
        searching = false;
        currentFen = "";
        pendingFen = null;

        if (interval) {
            clearInterval(interval);
            interval = null;
        }

        if (engine) {
            engine.postMessage("stop");
            engine.postMessage("quit");
            engine.terminate();
            engine = null;
        }

        const panel =
            document.getElementById("chess-analysis-info");

        if (panel) panel.remove();

        button.textContent = "Chess";

        console.log("Analysis stopped");
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
        if (analysisRunning) {
            stopAnalysis();
        } else {
            startAnalysis();
        }
    });

    // =====================================
    // INSERT INTO PAGE
    // =====================================

    const mainBody =
        document.querySelector(".board-layout-main");

    if (mainBody) {
        mainBody.prepend(button);
    } else {
        console.error("Main page container not found");
    }

    // =====================================
    // PUBLIC TEST INTERFACE
    // =====================================

    window.ChessBotTest = {
        start: startTestGame,
        move: playTestMove,
        getPosition: () => game.fen,
        getMoves: () => [...game.moves],
        getStatus: () => game.status,
        analyze: fen => {
            if (!engineReady) {
                console.warn("Engine is not ready.");
                return;
            }

            analyze(fen || game.fen);
        }
    };

})();
