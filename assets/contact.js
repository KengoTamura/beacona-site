/* お問い合わせフォーム送信（プログレッシブ・エンハンスメント）
   - JS無効でも <form> の通常POSTで /api/contact に届く（フォールバック）。
   - script-src 'self' の範囲内（外部JS／インライン不要）。 */
(function () {
  "use strict";
  var form = document.getElementById("form");
  if (!form || !window.fetch) return;
  var btn = form.querySelector("button[type=submit]");
  var statusEl = document.getElementById("form-status");

  function showError(msg, fields) {
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = msg; }
    if (btn) { btn.disabled = false; btn.textContent = "無料で相談する"; }
    if (fields && fields.length) {
      var first = form.querySelector('[name="' + fields[0] + '"]');
      if (first) first.focus();
    }
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }
    if (btn) { btn.disabled = true; btn.textContent = "送信中…"; }

    var fd = new FormData(form), payload = {};
    fd.forEach(function (v, k) {
      if (k === "service") { (payload.service = payload.service || []).push(v); }
      else { payload[k] = v; }
    });

    fetch(form.getAttribute("action"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; });
    }).then(function (d) {
      if (d && d.ok) {
        form.innerHTML =
          '<div class="form-done"><p class="form-done-h">送信しました。ありがとうございます。</p>' +
          '<p class="form-note">担当より数日以内にご連絡します。ご連絡先にメールをご記入いただいた場合は、確認の自動返信メールをお送りしています（届かないときは迷惑メールフォルダもご確認ください）。</p></div>';
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        showError((d && d.error) || "送信に失敗しました。お手数ですが info@beacona.jp までご連絡ください。", d && d.fields);
      }
    }).catch(function () {
      showError("通信エラーが発生しました。電波状況をご確認のうえ、再度お試しください。");
    });
  });
})();
