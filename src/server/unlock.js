export function restrictedPage(mode) {
  const action = mode === 'enrollment' ? 'Set up your passkey' : 'Unlock your vault';
  return Buffer.from(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${action} - SecretCLI</title>
  <link rel="stylesheet" href="/styles.css">
  <script type="module" src="/unlock.js"></script>
</head>
<body data-mode="${mode}"><main><h1>${action}</h1></main></body>
</html>`);
}
