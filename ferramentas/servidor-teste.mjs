// Simula o ESP32 no computador: serve a página embutida no sketch, o modelo 3D e as
// mesmas leituras fictícias do firmware. Serve para testar a aplicação sem gravar a placa.
//
//   cd ferramentas
//   npm run servidor          → http://localhost:8080
//
// Variáveis opcionais: PORTA=8080 · ADIANTAR_S=65 (pula direto para perto do desbalanceamento)

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.PORTA || 8080);
const ADIANTAR_S = Number(process.env.ADIANTAR_S || 0);

const ino = await readFile(path.join(aqui, '../MecMonitor/MecMonitor.ino'), 'utf8');
const pagina = ino.match(/R"rawliteral\(([\s\S]*?)\)rawliteral"/)[1];
const glb = await readFile(path.join(aqui, '../Modelo/bomba-mecmonitor.glb'));
const modeloGz = gzipSync(glb, { level: 9 });
const etag = `"${createHash('sha1').update(glb).digest('hex').slice(0, 10)}"`;

// Mesma simulação de atualizarSimulado() no sketch, a cada 200 ms.
const inicio = Date.now();
let temperatura = 46;
let leitura = {};
const ruido = (a) => (Math.random() * 2 - 1) * a;
function intensidadeEvento(t) {
  const fase = t % 120;
  if (fase < 70) return 0;
  if (fase < 80) return (fase - 70) / 10;
  if (fase < 95) return 1;
  if (fase < 110) return 1 - (fase - 95) / 15;
  return 0;
}
function atualizar() {
  const t = (Date.now() - inicio) / 1000 + ADIANTAR_S;
  const ev = intensidadeEvento(t);
  const alvo = 48 + 2 * Math.sin(2 * Math.PI * t / 180) + 27 * ev;
  temperatura += (alvo - temperatura) * 0.03;
  const r2 = (v) => Math.round(v * 100) / 100;
  leitura = {
    temp: Math.round((temperatura + ruido(0.2)) * 4) / 4,
    vib: r2(1.8 + 0.25 * Math.sin(2 * Math.PI * t / 13) + 3.4 * ev + ruido(0.12)),
    corrente: r2(2.75 + 0.08 * Math.sin(2 * Math.PI * t / 7) + 0.5 * ev + ruido(0.03)),
    sim: true,
    uptime: Math.floor(t),
  };
}
atualizar();
setInterval(atualizar, 200);

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(pagina);
  } else if (pathname === '/dados') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(leitura));
  } else if (pathname === '/bomba.glb') {
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'model/gltf-binary', 'Content-Encoding': 'gzip', 'Content-Length': modeloGz.length,
      ETag: etag, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*',
    });
    res.end(modeloGz);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  }
}).listen(PORTA, () => {
  console.log(`ESP32 simulado em http://localhost:${PORTA}  (Ctrl+C para parar)`);
});
