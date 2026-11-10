const express = require('express');
const path = require('path');
const app = express();

// Configura a pasta para servir o HTML e arquivos estáticos
app.use(express.static(path.join(__dirname)));

// Rota coringa que garante que qualquer acesso entregue o seu index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'portal_reforma_tribut_ria_brasil (3).html'));
});

// Porta padrão exigida pelo Fly.io
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});