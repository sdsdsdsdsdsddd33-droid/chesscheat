(() => {
    "use strict";

    const CONFIG = {
        movetime: 5000,
        threads: 2,
        hash: 256,
        multiPV: 1,
        skillLevel: 20
    };

    let engine = null;
    let initialized = false;
    let busy = false;

    const panel = document.createElement("div");

    panel.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 999999;
        width: 320px;
        padding: 16px;
        background: #202124;
        color: white;
        border-radius: 12px;
        font-family: Arial, sans-serif;
        box-shadow: 0 4px 20px #0008;
    `;

    panel.innerHTML = `
        <h3>Stockfish Analyse</h3>

        <textarea id="fenInput"
            placeholder="FEN-Position eingeben"
            style="width:100%;height:65px;box-sizing:border-box;">
        </textarea>

        <button id="analyzeBtn">Position analysieren</button>
        <button id="stopBtn">Stoppen</button>

        <p id="status">Engine nicht gestartet</p>
        <pre id="result"></pre>
    `;

    document.body.appendChild(panel);

    const fenInput = panel.querySelector("#fenInput");
    const analyzeBtn = panel.querySelector("#analyzeBtn");
    const stopBtn = panel.querySelector("#stopBtn");
    const status = panel.querySelector("#status");
    const result = panel.querySelector("#result");

    function createEngine() {
        if (engine) return;

        engine = new Worker(
            chrome.runtime.getURL("engine/stockfish.js")
        );

        engine.onmessage = (event) => {
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

                engine.postMessage(
                    "setoption name UCI_AnalyseMode value true"
                );

                engine.postMessage("isready");
            }

            if (message === "readyok") {
                initialized = true;
                status.textContent = "Engine bereit";
            }

            if (message.startsWith("info ")) {
                result.textContent = message;
            }

            if (message.startsWith("bestmove ")) {
                result.textContent = message;
                busy = false;
                status.textContent = "Analyse abgeschlossen";
                analyzeBtn.disabled = false;
            }
        };

        engine.onerror = () => {
            status.textContent = "Fehler beim Laden der Engine";
            busy = false;
            analyzeBtn.disabled = false;
        };

        engine.postMessage("uci");
    }

    function stopAnalysis() {
        if (!engine) return;

        engine.postMessage("stop");

        busy = false;
        analyzeBtn.disabled = false;
        status.textContent = "Analyse gestoppt";
    }

    function analyze() {
        const fen = fenInput.value.trim();

        if (!fen) {
            status.textContent = "Bitte eine FEN eingeben";
            return;
        }

        if (!initialized) {
            createEngine();
            status.textContent = "Engine wird initialisiert";
            return;
        }

        if (busy) return;

        busy = true;
        analyzeBtn.disabled = true;

        result.textContent = "";
        status.textContent = "Analysiere ...";

        engine.postMessage("ucinewgame");
        engine.postMessage(`position fen ${fen}`);

        engine.postMessage(
            `go movetime ${CONFIG.movetime}`
        );
    }

    analyzeBtn.addEventListener("click", analyze);
    stopBtn.addEventListener("click", stopAnalysis);

    window.addEventListener("beforeunload", () => {
        if (engine) {
            engine.postMessage("quit");
            engine.terminate();
            engine = null;
        }
    });

})();
