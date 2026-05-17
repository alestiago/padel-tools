# Plan: Herramienta de calibración manual de homografía

## Objetivo

Construir una interfaz que permita al usuario:
1. Cargar un vídeo de entrenamiento de padel.
2. Seleccionar un frame de referencia limpio.
3. Marcar manualmente los puntos de referencia de la pista clicando sobre el frame.
4. Calcular y validar la homografía H en el propio navegador.
5. Exportar la matriz H en JSON para ser consumida por el pipeline de análisis.

Todo el procesado ocurre **on-device**: sin servidores, sin subir vídeo a ningún lado.

---

## Evaluación de frameworks

### Requisitos técnicos que condicionan la elección

- La app es **100% client-side**. No hay datos que necesiten SSR, API routes ni base de datos.
- Necesita cargar y usar **módulos WASM** pesados (opencv.js ~3 MB gzip, onnxruntime-web ~5 MB gzip).
- El bundle final se desplegará como **ficheros estáticos** (GitHub Pages, Netlify, etc.).
- La UI tiene estado local complejo (lista de puntos, frame actual, resultados) — un framework con reactividad ayuda.

---

### Opción 1 — Next.js

Next.js es un framework React con SSR/SSG. Para esta herramienta su uso sería en modo `output: 'export'` (generación estática pura).

**Problemas con WASM en Next.js**:
- El runtime de Next.js importa módulos con `require()` durante SSR, lo que rompe módulos WASM que asumen `window`/`document`. Es necesario envolver las importaciones en `dynamic(() => import(...), { ssr: false })` para cada módulo WASM.
- El webpack de Next.js necesita configuración manual para habilitar el soporte WASM experimental (`asyncWebAssembly: true` en `next.config.js`).
- Los headers de **Cross-Origin Isolation** (`COOP` / `COEP`), necesarios para `SharedArrayBuffer` que usa opencv.js en modo multihilo, requieren configuración adicional de cabeceras HTTP que en static export no es trivial.

**Ventajas**:
- Ecosistema React familiar.
- Si en el futuro se quisieran añadir API routes (e.g., para persistencia en la nube), ya estaría disponible.

**Veredicto**: Añade complejidad sin aportar nada a este caso de uso. WASM es un ciudadano de segunda clase en Next.js.

---

### Opción 2 — Vite + React

Vite es un bundler diseñado para la era ESM. React se añade como plugin.

**Soporte WASM**:
- WASM es soportado de forma nativa como módulo ESM con el plugin `vite-plugin-wasm` (o el flag experimental `--experimental-vm-wasm` en Vite 5+).
- Sin configuración adicional para `SharedArrayBuffer`: basta añadir los headers en `vite.config.ts` para dev, y en el hosting para producción.
- opencv.js se carga con un script tag clásico o como módulo dinámico sin fricción.

**Ventajas**:
- Dev server arranca en <500 ms. HMR instantáneo.
- Bundle final más ligero que Next.js (sin runtime de React Server Components ni router).
- Deploy estático sin ninguna adaptación.
- `vite-plugin-wasm` + `vite-plugin-top-level-await` resuelven el 100% de los casos de uso WASM en dos líneas de config.

**Desventajas**:
- Sin SSR si en el futuro se necesitara (pero no aplica aquí).

**Veredicto**: La opción óptima para esta herramienta.

---

### Opción 3 — SvelteKit (static adapter)

SvelteKit con `@sveltejs/adapter-static` genera ficheros estáticos.

**Soporte WASM**: Similar a Vite (SvelteKit usa Vite internamente). La integración WASM es igual de sencilla.

**Ventajas**: Bundles más pequeños que React, sintaxis de componentes más concisa, reactividad sin boilerplate de hooks.

**Desventajas**: Ecosistema más pequeño. Menos librerías UI. Si el resto del stack de PadelTools es React, mezclar frameworks no tiene sentido.

**Veredicto**: Técnicamente comparable a Vite+React, pero no tiene ventaja suficiente para justificar la curva de aprendizaje si React ya es conocido.

---

### Opción 4 — Electron (app de escritorio)

Electron embebe Chromium + Node.js en un ejecutable nativo.

**Ventajas**: Acceso directo al sistema de ficheros, se puede usar `opencv4nodejs` (bindings nativos de OpenCV sin WASM). Sin restricciones de CORS ni WASM.

**Desventajas**: Instalación requerida (~200 MB). No es una web. Distribución y actualización más compleja.

**Veredicto**: Descartado. El objetivo es una herramienta web sin instalación.

---

### Tabla comparativa de frameworks

| Criterio                        | Next.js            | **Vite + React**   | SvelteKit          | Electron           |
|---------------------------------|--------------------|--------------------|--------------------|--------------------|
| Soporte WASM nativo             | ✗ Requiere config  | ✓ Con un plugin    | ✓ Con un plugin    | ✓ Nativo           |
| Deploy como ficheros estáticos  | ✓ (con `export`)   | ✓                  | ✓                  | ✗                  |
| Sin instalación para el usuario | ✓                  | ✓                  | ✓                  | ✗                  |
| Tamaño del bundle (runtime)     | ~90 KB             | ~40 KB             | ~15 KB             | ~200 MB            |
| Velocidad de dev server         | ★★★☆☆              | ★★★★★              | ★★★★★              | ★★☆☆☆              |
| SharedArrayBuffer (multihilo)   | Complejo           | Sencillo           | Sencillo           | Nativo             |
| Ecosistema / librerías UI       | ★★★★★              | ★★★★★              | ★★★☆☆              | ★★★★☆              |
| Complejidad de configuración    | Alta               | **Baja**           | Baja               | Media              |

**Elección: Vite + React.**

---

## Stack tecnológico

```
Vite 6 + React 19 + TypeScript
│
├── opencv.js (WASM)          — findHomography, warpPerspective, canvas ops
├── onnxruntime-web (WASM)    — inferencia del modelo YOLO-pose (asistencia automática)
├── vite-plugin-wasm          — soporte WASM nativo en Vite
└── vite-plugin-top-level-await  — await en el módulo raíz para inicializar cv
```

**Librerías UI**:
- `@radix-ui/react-*` — primitivas accesibles (tooltips, diálogos).
- `tailwindcss` — estilos utilitarios.
- No hace falta ninguna librería de canvas: se usa la Canvas API directa con React refs.

---

## Librerías WASM

### opencv.js

El build oficial de OpenCV para WebAssembly. Expone prácticamente toda la API de OpenCV en JS.

Funciones que se usarán:
- `cv.findHomography(srcPoints, dstPoints, cv.RANSAC, 0.5)` — calcula H.
- `cv.warpPerspective(src, dst, H, dsize)` — genera el bird's-eye view para validación visual.
- `cv.perspectiveTransform(pts, dst, H)` — proyecta puntos individuales.

Carga: se descarga una sola vez y se cachea por el service worker / browser cache. No necesita backend.

```ts
// Inicialización lazy (solo cuando se necesita)
let cv: any = null;
async function getCV() {
  if (!cv) {
    cv = await import('/vendor/opencv.js');
    await cv.ready;
  }
  return cv;
}
```

### onnxruntime-web

Permite ejecutar modelos ONNX directamente en el navegador. Soporta tres backends:
- `wasm` — compatible con cualquier navegador moderno.
- `webgpu` — aceleración GPU en Chrome 113+. ~5–10x más rápido para inferencia.

Se usará para ejecutar el modelo de keypoints de la pista (Enfoque C de `homografia.md`) como **asistencia opcional**: el modelo sugiere los puntos automáticamente y el usuario los corrige clicando.

```ts
import * as ort from 'onnxruntime-web';

const session = await ort.InferenceSession.create('/models/court_keypoints.onnx', {
  executionProviders: ['webgpu', 'wasm'],  // WebGPU con fallback a WASM
});
```

---

## Diseño de la interfaz (UX)

La herramienta tiene tres pantallas/estados:

### Pantalla 1 — Carga del vídeo

```
┌─────────────────────────────────────────┐
│                                         │
│        Arrastra un vídeo aquí           │
│        o haz clic para seleccionar      │
│                                         │
│        [Formatos: MP4, MOV, WebM]       │
│                                         │
└─────────────────────────────────────────┘
```

- Drag & drop o file picker (`<input type="file" accept="video/*">`).
- El vídeo **nunca sale del dispositivo**. Se carga en un `<video>` element local.

---

### Pantalla 2 — Selección de frame

```
┌──────────────────────────────┐
│                              │
│      [Frame del vídeo]       │
│                              │
├──────────────────────────────┤
│  ◄◄  ◄  ▶  ►  ▶▶  │ 00:12  │
│  ════════●═══════════════    │
└──────────────────────────────┘
 [Extraer este frame y continuar →]
```

- Scrubber de tiempo con preview en tiempo real.
- El usuario busca un frame sin jugadores tapando las líneas (inicio del punto, entre puntos).
- Botón para capturar el frame en un `<canvas>` y pasar a la siguiente pantalla.

---

### Pantalla 3 — Anotación de puntos

Layout en dos paneles:

```
┌──────────────────────────┬──────────────────┐
│                          │   PISTA (top-down)│
│   Frame de vídeo         │                  │
│   (canvas interactivo)   │   ┌────────┐     │
│                          │   │   ●    │ ← A │
│   ● ← punto marcado      │   │        │     │
│   ○ ← punto actual       │   │   ○    │ ← B │
│                          │   └────────┘     │
│                          │                  │
├──────────────────────────┴──────────────────┤
│  Marcando: B — Esquina trasera derecha (10, 0) │
│  Puntos marcados: 1 / 8   [Deshacer] [Calcular H ▶] │
└─────────────────────────────────────────────┘
```

**Comportamiento del canvas izquierdo**:
- Cursor crosshair sobre la imagen.
- Al hacer clic, se coloca el punto actual y se avanza al siguiente.
- Los puntos se pueden arrastrar para reposicionarlos.
- Hotkey `Z` para deshacer el último punto.
- Hotkey `Espacio` para confirmar posición del punto actual sin mover.

**Panel derecho (SVG del top-down)**:
- Diagrama SVG de la pista de padel con las dimensiones reales.
- Cada punto pendiente aparece como círculo hueco. El punto actual parpadea.
- Al marcarlo, se rellena con el color del punto.
- Sirve como guía visual de qué intersección debe marcar el usuario en el frame.

**Asistencia automática (opcional)**:
- Si el modelo ONNX está disponible, al cargar el frame se ejecuta y sugiere posiciones de los keypoints como puntos grises semitransparentes.
- El usuario puede aceptar una sugerencia clicando sobre ella o ignorarla y hacer clic donde quiera.

---

### Pantalla 4 — Validación y exportación

```
┌──────────────────────────┬──────────────────┐
│                          │  Error de         │
│   Frame con overlay      │  reproyección     │
│   de la cuadrícula       │                  │
│   de la pista            │  Media: 0.031 m   │
│                          │  Máx:   0.048 m   │
│                          │  Inliers: 8/8     │
│                          │                  │
│                          │  ✓ Calibración   │
│                          │    aceptable      │
├──────────────────────────┴──────────────────┤
│  [← Volver a ajustar]     [Exportar JSON ↓] │
└─────────────────────────────────────────────┘
```

El overlay dibuja las líneas de la pista proyectadas sobre el frame usando `warpPerspective` inverso. Si la homografía es buena, las líneas proyectadas coinciden con las líneas reales del frame.

El JSON exportado tiene el formato:
```json
{
  "version": 1,
  "timestamp": "2026-05-17T10:00:00Z",
  "video_file": "entrenamiento_2026-05-17.mp4",
  "frame_index": 312,
  "H": [
    [h11, h12, h13],
    [h21, h22, h23],
    [h31, h32, h33]
  ],
  "reprojection_error_m": 0.031,
  "keypoints": [
    { "id": "A", "img": [u, v], "real": [0, 0] },
    ...
  ]
}
```

---

## Arquitectura de componentes

```
App
├── VideoLoader            — drag & drop, file input
├── FramePicker            — <video> + scrubber + canvas capture
├── AnnotationTool
│   ├── AnnotationCanvas   — canvas con click/drag handlers
│   ├── CourtDiagram       — SVG top-down con estado de puntos
│   ├── PointQueue         — lista ordenada de puntos pendientes
│   └── ModelAssist        — inferencia ONNX opcional (lazy loaded)
├── HomographyEngine       — wrapper de opencv.js (findHomography, validación)
├── ValidationView
│   ├── OverlayCanvas      — frame + cuadrícula proyectada
│   └── StatsPanel         — error de reproyección, inliers
└── ExportPanel            — serialización JSON + descarga
```

`HomographyEngine` es un módulo puro (sin UI) que el resto de componentes llaman mediante un hook `useHomography()`. Esto mantiene la lógica de OpenCV aislada y testeable.

---

## Fases de implementación

### Fase 1 — Scaffolding y carga de vídeo (½ día)
- Inicializar proyecto: `npm create vite@latest padel-tools -- --template react-ts`
- Configurar `vite-plugin-wasm` y cabeceras COOP/COEP.
- Implementar `VideoLoader` y `FramePicker` con captura a canvas.

### Fase 2 — Anotación manual (1 día)
- Implementar `AnnotationCanvas` con click para colocar y drag para mover puntos.
- Implementar `CourtDiagram` en SVG con los 8 keypoints de referencia.
- Conectar ambos: al marcar un punto en el canvas, se actualiza el diagrama.

### Fase 3 — Cómputo de homografía con opencv.js (½ día)
- Integrar opencv.js con carga lazy.
- Implementar `HomographyEngine.compute()` con `findHomography` + RANSAC.
- Implementar `HomographyEngine.validate()` que devuelve el error de reproyección.

### Fase 4 — Validación visual (½ día)
- Implementar `OverlayCanvas`: proyectar la cuadrícula de la pista sobre el frame.
- Implementar `StatsPanel` con los valores de error.

### Fase 5 — Exportación (¼ día)
- Serializar resultado a JSON y ofrecer descarga con `URL.createObjectURL`.
- Guardar en `localStorage` para recuperar si el usuario cierra y vuelve.

### Fase 6 — Asistencia automática con ONNX (opcional, 1–2 días)
- Integrar `onnxruntime-web`.
- Exportar el modelo YOLO-pose a ONNX y añadir pre/post procesado.
- Mostrar sugerencias como puntos fantasma que el usuario puede aceptar o ignorar.

---

## Consideraciones de despliegue

- **Cross-Origin Isolation**: opencv.js necesita `SharedArrayBuffer`, que requiere los headers:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```
  En Netlify/Vercel se añaden en `netlify.toml` / `vercel.json`. En GitHub Pages se puede usar el workaround con service worker (`coi-serviceworker`).

- **Tamaño de carga inicial**: Los módulos WASM son grandes. Estrategia:
  - opencv.js se carga solo cuando el usuario llega a la pantalla de anotación (lazy import).
  - El modelo ONNX solo se descarga si el usuario activa la asistencia automática.
  - Se usa `Cache-Control: max-age=31536000, immutable` para que no se vuelvan a descargar.

- **Compatibilidad**: Todos los navegadores modernos (Chrome 90+, Firefox 89+, Safari 15+) soportan WASM. WebGPU solo en Chrome 113+ — con fallback automático a WASM.


# Adjustments

- Sometimes corners are out of frame
- When selecting we should get a circular magnifying view for better precision since cursor obscures the image.