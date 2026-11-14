// パスワードを入れる画面。外部のファイルを読まない（認証前はゲームの素材を返さないため）。

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: grid; place-items: center;
  padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  background: #14181c; color: #e8ecef;
  font: 16px/1.5 system-ui, -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif;
}
main { width: 100%; max-width: 360px; padding: 20px; border-radius: 12px; background: #1f252b; border: 1px solid #2f373f; }
h1 { margin: 0 0 16px; font-size: 18px; font-weight: 600; }
label { display: block; margin-bottom: 6px; font-size: 14px; color: #aeb7c0; }
input {
  display: block; width: 100%; min-height: 44px; padding: 8px 12px;
  border-radius: 8px; border: 1px solid #3a444e; background: #14181c; color: inherit; font: inherit;
}
input:focus-visible, button:focus-visible { outline: 2px solid #6fd3a0; outline-offset: 2px; }
button {
  display: block; width: 100%; min-height: 44px; margin-top: 12px;
  border: 0; border-radius: 8px; background: #2f8f62; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
}
p { margin: 0; }
.error { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; background: #4a2326; color: #ffd7d9; font-size: 14px; }
`;

function shell(body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>openworld-cycling</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>openworld-cycling</h1>
${body}
</main>
</body>
</html>
`;
}

export function loginPage(options: { next: string; error?: string }): string {
  const error = options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>\n` : "";
  return shell(`${error}<form method="post" action="/__auth/login">
<input type="hidden" name="next" value="${escapeHtml(options.next)}">
<label for="password">パスワード</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="200">
<button type="submit">入る</button>
</form>`);
}

export function messagePage(message: string): string {
  return shell(`<p>${escapeHtml(message)}</p>`);
}
