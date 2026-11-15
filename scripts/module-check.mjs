import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';

export async function sourceFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const name = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(name)));
    else if (['.js', '.mjs'].includes(extname(name))) files.push(name);
  }
  return files.sort();
}

const layer = (name) =>
  name.startsWith('server/')
    ? 'server'
    : name.match(/^src\/(sim|protocol|net|client)\//)?.[1] || 'legacy';
const allowed = {
  sim: ['sim'],
  protocol: ['protocol'],
  net: ['net', 'sim', 'protocol'],
  client: ['client', 'net', 'sim', 'protocol', 'legacy'],
  server: ['server', 'sim', 'protocol'],
  legacy: ['legacy', 'client', 'net', 'sim', 'protocol'],
};
const cpuTypes = new Set([
  'Vector2',
  'Vector3',
  'Matrix3',
  'Matrix4',
  'Euler',
  'Quaternion',
  'Object3D',
  'Bone',
]);

/** Parses every local import edge, including legacy bridge modules; reports
 * forbidden layer/device dependencies, unresolved imports and dependency cycles. */
export async function checkModules(root) {
  root = resolve(root);
  const files = [
    ...(await sourceFiles(resolve(root, 'src'))),
    ...(await sourceFiles(resolve(root, 'server'))),
  ];
  const names = new Map(files.map((file) => [file, relative(root, file).replaceAll('\\', '/')]));
  const graph = new Map(),
    errors = [],
    linter = new Linter();
  for (const file of files) {
    const name = names.get(file),
      currentLayer = layer(name),
      edges = [];
    const threeNamespaces = new Set();
    const fail = (node, message) => errors.push(`${name}:${node.loc.start.line}: ${message}`);
    const imported = (node, specifier) => {
      if (typeof specifier !== 'string') {
        fail(node, 'Computed module imports are not allowed.');
        return;
      }
      if (!specifier.startsWith('.')) {
        if (currentLayer === 'sim' && specifier !== 'three')
          fail(node, `sim external dependency: ${specifier}`);
        if (
          currentLayer === 'protocol' &&
          !(name === 'src/protocol/blocks.js' && specifier === 'fflate/browser')
        )
          fail(node, `protocol external dependency: ${specifier}`);
        return;
      }
      const target = resolve(dirname(file), specifier);
      if (!names.has(target)) {
        fail(node, `Unresolved local module: ${specifier}`);
        return;
      }
      const targetLayer = layer(names.get(target));
      if (!allowed[currentLayer].includes(targetLayer))
        fail(node, `Forbidden ${currentLayer} -> ${targetLayer} import: ${specifier}`);
      edges.push(target);
    };
    const diagnostics = linter.verify(await readFile(file, 'utf8'), [
      {
        plugins: {
          architecture: {
            rules: {
              graph: {
                create() {
                  return {
                    ImportDeclaration(node) {
                      imported(node, node.source.value);
                      if (currentLayer === 'sim' && node.source.value === 'three') {
                        for (const specifier of node.specifiers) {
                          if (specifier.type === 'ImportNamespaceSpecifier')
                            threeNamespaces.add(specifier.local.name);
                          else if (
                            !cpuTypes.has(specifier.imported?.name) &&
                            specifier.imported?.name !== 'MathUtils'
                          )
                            fail(node, 'Non-CPU import from three.');
                        }
                      }
                    },
                    ExportNamedDeclaration(node) {
                      if (node.source) imported(node, node.source.value);
                    },
                    ExportAllDeclaration(node) {
                      imported(node, node.source.value);
                    },
                    ImportExpression(node) {
                      imported(node, node.source.value);
                    },
                    Identifier(node) {
                      if (
                        currentLayer === 'sim' &&
                        [
                          'window',
                          'document',
                          'performance',
                          'Date',
                          'setTimeout',
                          'setInterval',
                          'fetch',
                          'WebSocket',
                        ].includes(node.name)
                      )
                        fail(node, `Device/time API in sim: ${node.name}`);
                    },
                    MemberExpression(node) {
                      const property = node.property.name || node.property.value;
                      if (
                        currentLayer === 'sim' &&
                        threeNamespaces.has(node.object.name) &&
                        !cpuTypes.has(property) &&
                        property !== 'MathUtils'
                      )
                        fail(node, `Non-CPU three API: ${property}`);
                      if (
                        currentLayer === 'sim' &&
                        node.object.name === 'Math' &&
                        (node.property.name || node.property.value) === 'random'
                      )
                        fail(node, 'Rule random source must be supplied by host.');
                    },
                    NewExpression(node) {
                      if (
                        currentLayer === 'sim' &&
                        node.callee.object?.name === 'THREE' &&
                        !cpuTypes.has(node.callee.property.name)
                      )
                        fail(node, `Render object in sim: ${node.callee.property.name}`);
                    },
                  };
                },
              },
            },
          },
        },
        rules: { 'architecture/graph': 'error' },
      },
    ]);
    for (const diagnostic of diagnostics)
      if (diagnostic.fatal) errors.push(`${name}:${diagnostic.line}: ${diagnostic.message}`);
    graph.set(file, edges);
  }
  const active = new Set(),
    visited = new Set();
  function visit(file, chain) {
    if (active.has(file)) {
      errors.push(`Import cycle: ${[...chain, file].map((item) => names.get(item)).join(' -> ')}`);
      return;
    }
    if (visited.has(file)) return;
    active.add(file);
    for (const target of graph.get(file) || []) visit(target, [...chain, file]);
    active.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
  return { files: files.length, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkModules(fileURLToPath(new URL('../', import.meta.url)));
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
