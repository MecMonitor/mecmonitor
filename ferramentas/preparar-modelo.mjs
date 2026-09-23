// Gera a versão leve do modelo da bancada e a embute no sketch do ESP32.
//
//   cd ferramentas
//   npm install
//   npm run modelo                 (ou: node preparar-modelo.mjs caminho/do/modelo.glb)
//
// Entrada: ../Modelo/projeto_bomba_centrifuga2109final.glb  (exportado do SolidWorks)
// Saídas:  ../Modelo/bomba-mecmonitor.glb                   (simplificado + meshopt)
//          bloco "MODELO 3D" no fim de ../MecMonitor/MecMonitor.ino (gzip + Base64)
//
// O que o script faz:
//   1. Junta as peças em 4 grupos que a página usa: rotor (gira), mancal (esquenta),
//      motor e bancada (todo o resto). Cada grupo vira poucas malhas, uma por cor.
//   2. Simplifica a geometria com desvio máximo de TOLERANCIA_M metros.
//   3. Centraliza a bancada na origem, com o piso em y = 0 e a frente virada para -Z
//      na cena do Babylon.js, e põe a origem do rotor sobre o eixo da bomba.
//   4. Comprime com meshopt (EXT_meshopt_compression) e gzip.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  clearNodeTransform, dedup, flatten, getBounds, join, meshopt, prune,
  simplifyPrimitive, transformMesh, weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const ENTRADA = path.resolve(process.argv[2] || path.join(aqui, '../Modelo/projeto_bomba_centrifuga2109final.glb'));
const SAIDA = path.join(aqui, '../Modelo/bomba-mecmonitor.glb');
const SKETCH = path.join(aqui, '../MecMonitor/MecMonitor.ino');

// Desvio máximo da simplificação, em metros. Com 0,6 mm a forma das peças não muda
// a olho nu, e as roscas dos prisioneiros e as manoplas dos registros (a maior parte
// dos 930 mil triângulos originais) caem para uma fração.
const TOLERANCIA_M = Number(process.env.TOLERANCIA_M || 0.0006);

// Nomes das peças no SolidWorks → grupo na cena. O que não casar vai para "bancada".
const GRUPOS = [
  ['rotor', /^(Shaft-|IMPELLER|coupling Side|Coupling Under|socket set screw|parallel_din|radial ball bearing)/i],
  ['mancal', /^(House Bearing|Bearing Cover|bbcover)/i],
  ['motor', /^Motor teste/i],
];

// O SolidWorks exporta metais como PBR metálico sem cor definida ("metal branco"),
// que sem mapa de ambiente aparece preto. Aqui cada metal ganha uma cor fosca plausível.
function ajustarMaterial(mat) {
  const nome = (mat.getName() || '').toLowerCase();
  const [r, g, b, a] = mat.getBaseColorFactor();
  let cor = [r, g, b];
  if (mat.getMetallicFactor() > 0.5) {
    if (nome.includes('brass')) cor = [0.52, 0.33, 0.08];                    // latão
    else if (nome.includes('bronze')) cor = [0.26, 0.15, 0.07];              // bronze
    else if (nome.includes('castiron') && r > 0.9 && g < 0.1) cor = [0.55, 0.04, 0.03]; // ferro fundido pintado de vermelho
    else cor = [0.42, 0.44, 0.46];                                           // aço
  }
  mat.setBaseColorFactor([...cor, a]).setMetallicFactor(0).setRoughnessFactor(0.55);
}

const contarTriangulos = (doc) => doc.getRoot().listMeshes().reduce((s, m) =>
  s + m.listPrimitives().reduce((t, p) => t + (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3, 0), 0);

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

console.log(`Lendo ${path.basename(ENTRADA)}…`);
const doc = await io.read(ENTRADA);
const root = doc.getRoot();
const cena = root.listScenes()[0];
const triangulosOriginais = contarTriangulos(doc);

// Câmera exportada pelo SolidWorks, cores de vértice e UVs (não há texturas): fora.
for (const no of root.listNodes()) no.setCamera(null);
for (const cam of root.listCameras()) cam.dispose();
for (const malha of root.listMeshes()) {
  for (const prim of malha.listPrimitives()) {
    for (const sem of prim.listSemantics()) if (sem !== 'POSITION' && sem !== 'NORMAL') prim.setAttribute(sem, null);
  }
}
root.listMaterials().forEach(ajustarMaterial);

// Só os materiais são unificados aqui: malhas compartilhadas atrapalhariam o join.
await doc.transform(dedup({ propertyTypes: [PropertyType.MATERIAL] }), flatten());

// Eixo da bomba, medido no próprio eixo antes de juntar as peças.
const eixoOriginal = root.listNodes().find((n) => /^Shaft-/i.test(n.getName()));
if (!eixoOriginal) throw new Error('Peça "Shaft-1" (eixo) não encontrada no modelo.');
const be = getBounds(eixoOriginal);
const limites = getBounds(cena);
const cx = (limites.min[0] + limites.max[0]) / 2;
const cz = (limites.min[2] + limites.max[2]) / 2;
const piso = limites.min[1];
// Centraliza, apoia no piso e gira 180° em Y: no Babylon.js (mão esquerda) a frente
// da bancada fica virada para -Z, de onde a câmera e o usuário olham.
const CENTRALIZAR = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, cx, -piso, cz, 1];
const paraCena = ([x, y, z]) => [-(x - cx), y - piso, -(z - cz)];
const eixoY = (be.min[1] + be.max[1]) / 2 - piso;
const eixoZ = -((be.min[2] + be.max[2]) / 2 - cz);

// Relatório das peças que a página usa para posicionar os sensores (coordenadas do Babylon.js:
// x = -x do glTF por causa da troca de mão; y e z iguais).
const RELATORIO = /^(House Bearing|Motor teste|casing|CEMAR|senai_placa|INGAPOOL|Base-1|PUMP PROTECTION|hopperfunnel)/i;
const relatorio = [];
for (const no of root.listNodes()) {
  if (!no.getMesh() || !RELATORIO.test(no.getName())) continue;
  const b = getBounds(no);
  const [a, c] = [paraCena(b.min), paraCena(b.max)];
  const min = [-Math.max(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])];
  const max = [-Math.min(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])];
  relatorio.push(`  ${no.getName().padEnd(28)} x ${min[0].toFixed(3)}…${max[0].toFixed(3)}  y ${min[1].toFixed(3)}…${max[1].toFixed(3)}  z ${min[2].toFixed(3)}…${max[2].toFixed(3)}`);
}

// Agrupa as peças.
const grupos = {};
for (const [nome] of [...GRUPOS, ['bancada']]) {
  grupos[nome] = doc.createNode(nome);
  cena.addChild(grupos[nome]);
}
for (const no of cena.listChildren()) {
  if (Object.values(grupos).includes(no) || !no.getMesh()) continue;
  const grupo = GRUPOS.find(([, re]) => re.test(no.getName()));
  cena.removeChild(no);
  grupos[grupo ? grupo[0] : 'bancada'].addChild(no);
}

await doc.transform(join({ keepNamed: false }), prune());
for (const no of root.listNodes()) if (no.getMesh()) clearNodeTransform(no);
await doc.transform(weld());

for (const malha of root.listMeshes()) {
  for (const prim of malha.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const [min, max] = [pos.getMin([]), pos.getMax([])];
    const raio = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
    simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: 0, error: TOLERANCIA_M / raio });
  }
}

for (const malha of root.listMeshes()) transformMesh(malha, CENTRALIZAR);
// O rotor gira em torno da própria origem: leva a origem para o eixo da bomba.
for (const no of grupos.rotor.listChildren()) {
  if (no.getMesh()) transformMesh(no.getMesh(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -eixoY, -eixoZ, 1]);
}
grupos.rotor.setTranslation([0, eixoY, eixoZ]);

await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));

const glb = Buffer.from(await io.writeBinary(doc));
await writeFile(SAIDA, glb);
const gz = gzipSync(glb, { level: 9 });
const b64 = gz.toString('base64');
const versao = createHash('sha1').update(glb).digest('hex').slice(0, 10);

const linhas = b64.match(/.{1,1000}/g).map((l) => `"${l}"`).join('\n');
const bloco = [
  '// >>> MODELO 3D (gerado por ferramentas/preparar-modelo.mjs — não edite à mão)',
  `// Origem: ${path.basename(ENTRADA)}, ${Math.round(triangulosOriginais).toLocaleString('pt-BR')} triângulos`,
  `// Leve:   ${Math.round(contarTriangulos(doc)).toLocaleString('pt-BR')} triângulos, GLB ${(glb.length / 1024).toFixed(0)} KB, gzip ${(gz.length / 1024).toFixed(0)} KB`,
  `const char MODELO_VERSAO[] = "${versao}";`,
  'const char MODELO_GLB_GZ_B64[] PROGMEM =',
  `${linhas};`,
  '// <<< MODELO 3D',
].join('\n');

try {
  const ino = await readFile(SKETCH, 'utf8');
  const re = /\/\/ >>> MODELO 3D[\s\S]*?\/\/ <<< MODELO 3D/;
  if (!re.test(ino)) throw new Error('marcadores "// >>> MODELO 3D" e "// <<< MODELO 3D" não encontrados');
  await writeFile(SKETCH, ino.replace(re, () => bloco));
  console.log(`Sketch atualizado: ${path.relative(process.cwd(), SKETCH)}`);
} catch (erro) {
  console.warn(`Sketch não atualizado (${erro.message}).`);
}

console.log(`Triângulos: ${Math.round(triangulosOriginais).toLocaleString('pt-BR')} → ${Math.round(contarTriangulos(doc)).toLocaleString('pt-BR')}`);
console.log(`GLB leve: ${(glb.length / 1024).toFixed(0)} KB · gzip: ${(gz.length / 1024).toFixed(0)} KB · Base64: ${(b64.length / 1024).toFixed(0)} KB · versão ${versao}`);
console.log(`Eixo da bomba na cena: y = ${eixoY.toFixed(4)} m, z = ${eixoZ.toFixed(4)} m`);
console.log('Peças de referência (coordenadas do Babylon.js):');
console.log(relatorio.join('\n'));
