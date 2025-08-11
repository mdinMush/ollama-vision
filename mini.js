const express = require('express');
const app = express();

app.get('/', (_req, res) => res.send('OK'));

const PORT = process.env.PORT || 6000;
app.listen(PORT, () => console.log(`MINI listening on http://localhost:${PORT}`));
