(() => {
  const stage = document.getElementById("notation-stage"),
    frame = document.getElementById("viewer");
  let numbered = localStorage.getItem("psf-notation") === "numbered";
  const controls = document.createElement("div");
  controls.className = "performance-controls";
  controls.innerHTML =
    '<button id="notation-toggle">五线谱／简谱</button><select id="navigation-mode" aria-label="跟随模式"><option value="line">逐行跟随</option><option value="page">分页跟随</option></select><button id="focus-toggle">专注看谱</button><button id="resume-score">回到跟随位置</button><label><input type="checkbox" id="assessment-enabled">评分练习</label><button id="assessment-finish">结算评分</button><output id="assessment-result" aria-live="polite"></output>';
  stage.append(controls);
  const xmlExport = document.createElement("button");
  xmlExport.textContent = "导出谱面";
  xmlExport.onclick = () => window.dispatchEvent(new Event("psf-export-score"));
  controls.append(xmlExport);
  const assessmentPanel = document.createElement("section");
  assessmentPanel.className = "assessment-controls";
  assessmentPanel.append(
    document.getElementById("assessment-enabled").closest("label"),
    document.getElementById("assessment-finish"),
    document.getElementById("assessment-result"),
  );
  controls.append(assessmentPanel);
  function installAssessment() {
    document.getElementById("mic-panel-body").prepend(assessmentPanel);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", installAssessment);
  else installAssessment();

  const send = (method, args = []) =>
    frame.contentWindow.postMessage(
      { pianoViewer: true, method, args },
      location.origin,
    );
  document.getElementById("navigation-mode").value =
    localStorage.getItem("psf-navigation") || "line";
  document.getElementById("navigation-mode").onchange = (e) => {
    localStorage.setItem("psf-navigation", e.target.value);
    send("setNavigation", [e.target.value, true]);
  };
  document.getElementById("assessment-finish").onclick = () =>
    window.dispatchEvent(new Event("psf-assessment-finish"));
  window.addEventListener("psf-assessment", (e) => {
    const a = e.detail;
    document.getElementById("assessment-result").textContent =
      (a.score === null ? "—" : a.score.toFixed(1) + " 分") +
      " · 正确 " +
      a.correct +
      " / " +
      a.total +
      " · 错 " +
      a.wrong +
      " · 漏 " +
      a.missed +
      " · 多 " +
      a.extra +
      (a.finished ? "" : " · 待弹 " + a.pending);
  });
  document.getElementById("notation-toggle").onclick = () => {
    numbered = !numbered;
    localStorage.setItem("psf-notation", numbered ? "numbered" : "staff");
    send("setNotationMode", [numbered ? "numbered" : "staff"]);
  };
  document.getElementById("focus-toggle").onclick = () => {
    document.body.classList.toggle("performance-focus");
    document.getElementById("focus-toggle").textContent =
      document.body.classList.contains("performance-focus")
        ? "显示工具"
        : "专注看谱";
  };
  document.getElementById("resume-score").onclick = () =>
    window.dispatchEvent(new Event("psf-resume-follow"));
  const about = document.createElement("section");
  about.className = "card";
  about.innerHTML =
    '<div class="card__body"><h3>智能琴谱 Web 1.0 · 关于与开源</h3><p>浏览器使用与 Android 相同的 Magenta 模型、Parangonar 对齐和乐谱渲染器。Web MIDI 取决于浏览器支持。</p><p><a href="https://github.com/Jimmy-xuzimo/PianoScoreFollower-Web" target="_blank" rel="noopener">网页版源码</a> · <a href="https://github.com/Jimmy-xuzimo/PianoScoreFollower" target="_blank" rel="noopener">Android 项目</a> · <a href="https://jimmy-xuzimo.github.io/PianoScoreFollower/" target="_blank" rel="noopener">介绍网页</a></p><p><a href="LICENSE" target="_blank" rel="noopener">BSD 3-Clause</a> · <a href="THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener">全部开源署名与协议</a></p><details><summary>离线协议全文</summary><p><a href="assets/licenses/magenta-LICENSE.txt" target="_blank" rel="noopener">Apache 2.0：TensorFlow.js / Magenta / Parangonar</a></p><p><a href="assets/licenses/alphaTab-MPL-2.0.txt" target="_blank" rel="noopener">alphaTab · MPL 2.0</a></p><p><a href="assets/licenses/Bravura-OFL.txt" target="_blank" rel="noopener">Bravura · SIL OFL</a> · <a href="assets/licenses/piano-CC0.txt" target="_blank" rel="noopener">钢琴音源 · CC0</a></p></details></div>';
  document.querySelector("#screen-settings .page").append(about);
  window.addEventListener("message", (e) => {
    if (
      e.source === frame.contentWindow &&
      e.origin === location.origin &&
      e.data.type === "scoreLoaded"
    )
      send("setNotationMode", [numbered ? "numbered" : "staff"]);
  });
})();
