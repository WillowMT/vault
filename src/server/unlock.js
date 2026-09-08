export function restrictedPage(mode) {
  const heading = mode === 'enrollment' ? 'Set up your passkey' : 'Vault locked';
  const lede = mode === 'enrollment'
    ? 'Create a passkey once so this vault opens with Touch ID instead of your password.'
    : 'Unlock with your passkey to open this vault in the browser.';
  const foot = mode === 'enrollment'
    ? 'You can finish setup from the terminal at any time.'
    : 'Or press R in the terminal to unlock with your recovery password.';
  return Buffer.from(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#202e28">
  <title>${heading} - SecretCLI</title>
  <link rel="stylesheet" href="/styles.css">
  <script type="module" src="/unlock.js"></script>
</head>
<body data-mode="${mode}">
<main class="unlock-shell">
  <section class="unlock-card">
    <div class="unlock-brand"><span class="brand-mark">◆</span>secret<span class="brand-suffix">cli</span></div>
    <p class="unlock-tagline">A little space. Only yours.</p>
    <p class="unlock-lede">${lede}</p>
    <h1>${heading}</h1>
    <footer class="unlock-foot">${foot}</footer>
  </section>
</main>
</body>
</html>`);
}
