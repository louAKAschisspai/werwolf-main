const express = require('express');

const app = express();
const PORT = 8080;

app.use(express.static('/app/frontend'));

app.listen(PORT, () => {
    console.log(`Server läuft auf http://localhost:${PORT}`);
});