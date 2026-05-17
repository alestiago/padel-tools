# Plan: Lupa de precisión en selección de puntos (AnnotationCanvas)

## Problema

Cuando el usuario hace clic sobre el canvas de anotación para marcar un keypoint, el cursor del
ratón cubre parcialmente la imagen justo en el área de interés, dificultando la precisión. En una
herramienta de calibración de homografía, unos pocos píxeles de error por keypoint se amplifican
en el resultado final. La lupa soluciona esto mostrando una vista ampliada del área bajo el cursor
sin ocultar la imagen original.

---

## Concepto

Mientras el cursor se mueve sobre el canvas de anotación en modo de selección de puntos, se
renderiza un **círculo de lupa** (loupe) que sigue el cursor. El círculo muestra una versión
ampliada (zoom ×3) de la región de la imagen bajo el cursor, con un retículo de precisión en el
centro que indica exactamente dónde caerá el clic.

El cursor del sistema se oculta dentro del canvas y se reemplaza por el retículo dibujado dentro
de la lupa, eliminando así cualquier oclusión.

```
  Canvas principal                  Lupa (overlay)
  ┌─────────────────────────┐       ┌──────────────────────────┐
  │                         │       │       ╔═══════╗           │
  │   ...imagen de pista... │       │       ║ ╋ ←── ║  retículo │
  │                         │       │       ╚═══════╝           │
  │         ⊕  ← posición   │       │  círculo con borde        │
  │            del clic      │       │  muestra zoom ×3          │
  └─────────────────────────┘       └──────────────────────────┘
```

La lupa se posiciona en la esquina superior derecha del canvas (posición fija) para no solaparse
nunca con el punto que el usuario está mirando.

---

## Comportamiento detallado

### Cuándo se muestra

- Solo durante la selección activa de un keypoint (el canvas está en modo `placing`).
- Se oculta al salir el cursor del canvas (`mouseleave`).
- Se oculta mientras el usuario arrastra un punto ya colocado (modo `dragging`).
- La lupa **no** se muestra en la pantalla de validación (`ValidationView`), solo en `AnnotationCanvas`.

### Posición de la lupa

La lupa se ancla en la esquina superior derecha del canvas, con un margen de 12 px. Esto
garantiza que no se solape con el área que el usuario mira (que siempre está cerca del cursor, en
el centro o izquierda del canvas). Si el canvas es muy estrecho (< 400 px), la lupa pasa a la
esquina superior izquierda.

### Zoom y tamaño

| Parámetro       | Valor por defecto |
|-----------------|-------------------|
| Diámetro lupa   | 140 px            |
| Factor de zoom  | ×3                |
| Radio de origen | 140 / (2 × 3) ≈ 23 px de radio en la imagen original |

Estos valores se pueden afinar con constantes en el componente para futuras iteraciones.

### Retículo

Dentro de la lupa, el retículo es una cruz delgada (1 px, color blanco con sombra negra de 1 px
para contraste) centrada exactamente en el punto focal. El retículo se extiende hasta el borde del
círculo para poder alinear con precisión.

### Borde de la lupa

Un anillo de 2 px en color `rgba(255,255,255,0.85)` con sombra suave exterior. Sobre el borde
inferior se imprime la coordenada de píxel actual `(u, v)` en fuente monoespaciada pequeña para
que el usuario pueda verificar la posición numérica.

---

## Implementación técnica

### Estrategia de renderizado

Se dibuja la lupa directamente sobre el canvas principal en cada frame de `mousemove`, encima de
la imagen y los puntos existentes. No se necesita un segundo elemento `<canvas>`: el orden de
dibujo dentro del mismo contexto 2D es suficiente.

El flujo de `drawFrame()` se extiende con un paso adicional al final:

```
1. ctx.drawImage(frameImage, ...)       — imagen del frame
2. drawExistingPoints(ctx, points)      — puntos ya colocados
3. drawCurrentPointGuide(ctx, current)  — guía del punto actual
4. drawLoupe(ctx, mousePos, frameImage) — lupa (si procede)  ← NUEVO
```

### `drawLoupe(ctx, mousePos, source)`

```ts
function drawLoupe(
  ctx: CanvasRenderingContext2D,
  mouse: { x: number; y: number },
  source: HTMLImageElement | HTMLCanvasElement,
  canvasW: number,
  canvasH: number
): void {
  const RADIUS = 70;           // px — radio del círculo de la lupa
  const ZOOM = 3;
  const MARGIN = 12;

  // Región de origen en la imagen original
  const srcRadius = RADIUS / ZOOM;
  const sx = mouse.x - srcRadius;
  const sy = mouse.y - srcRadius;
  const srcSize = srcRadius * 2;

  // Posición del centro de la lupa (esquina superior derecha)
  const lx = canvasW - RADIUS - MARGIN;
  const ly = RADIUS + MARGIN;

  // Clip circular
  ctx.save();
  ctx.beginPath();
  ctx.arc(lx, ly, RADIUS, 0, Math.PI * 2);
  ctx.clip();

  // Dibujar región ampliada
  ctx.drawImage(source, sx, sy, srcSize, srcSize, lx - RADIUS, ly - RADIUS, RADIUS * 2, RADIUS * 2);

  // Retículo
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2;
  drawCrosshair(ctx, lx, ly, RADIUS);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  drawCrosshair(ctx, lx, ly, RADIUS);

  ctx.restore();

  // Borde exterior del círculo (fuera del clip)
  ctx.save();
  ctx.beginPath();
  ctx.arc(lx, ly, RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.restore();

  // Coordenadas bajo la lupa
  ctx.save();
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'center';
  ctx.fillText(`(${Math.round(mouse.x)}, ${Math.round(mouse.y)})`, lx, ly + RADIUS + 14);
  ctx.restore();
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number
): void {
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();
}
```

### Ocultar el cursor del sistema

```tsx
// En el elemento <canvas> del AnnotationCanvas
<canvas
  style={{ cursor: isPlacingPoint ? 'none' : 'crosshair' }}
  onMouseMove={handleMouseMove}
  onMouseLeave={() => setMousePos(null)}
  ...
/>
```

Cuando `isPlacingPoint` es `true`, `cursor: none` oculta el cursor del sistema dentro del canvas.
El retículo de la lupa sirve como cursor visual de sustitución.

### Estado añadido al componente `AnnotationCanvas`

```ts
const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
```

`mousePos` se actualiza en `handleMouseMove` con las coordenadas relativas al canvas
(`event.offsetX`, `event.offsetY`). Se pone a `null` en `mouseleave` para suprimir la lupa.

### Invalidación del canvas (requestAnimationFrame)

El canvas ya se redibuja en cada evento de interacción. El `mousemove` disparará `drawFrame()`,
que incluirá `drawLoupe()` al final. No se necesita ningún loop de animación adicional: el
movimiento del ratón ya provoca la actualización suficientemente rápido para percibir fluidez.

Si en el futuro el canvas pasa a usar un loop RAF, `drawLoupe` simplemente se añade al final de
ese loop.

---

## Casos límite

| Caso | Comportamiento |
|---|---|
| Cursor cerca del borde derecho del canvas | La lupa cambia automáticamente a esquina superior **izquierda** si `mouse.x > canvasW * 0.6` |
| Cursor cerca del borde de la imagen | `drawImage` con `sx < 0` o `sy < 0` — Canvas 2D recorta automáticamente; no se necesita manejo especial |
| Canvas muy pequeño (< 300 px de ancho) | Reducir `RADIUS` a 50 px y `ZOOM` a ×2 |
| Modo `dragging` (arrastrar punto existente) | `drawLoupe` no se llama; el cursor vuelve a `crosshair` |
| Pantalla táctil | La lupa no aplica en eventos `touch`; el comportamiento táctil queda sin cambios |

---

## Componentes afectados

| Componente / fichero | Cambio |
|---|---|
| `AnnotationCanvas.tsx` | Añadir `mousePos` state; `handleMouseMove`/`handleMouseLeave`; llamada a `drawLoupe` al final de `drawFrame`; `cursor: none` cuando `isPlacingPoint` |
| `drawLoupe.ts` (nuevo helper) | Función pura `drawLoupe(ctx, mouse, source, w, h)` y `drawCrosshair` |

No se toca ningún otro componente: la lupa es un efecto puramente visual en la capa de renderizado
del canvas.

---

## Fases de implementación

1. **Helper `drawLoupe`** — Implementar y verificar en aislamiento con un canvas de prueba.
2. **Integración en `AnnotationCanvas`** — Añadir estado `mousePos`, eventos `mousemove`/`mouseleave`, llamada en `drawFrame`, `cursor: none`.
3. **Casos límite** — Lupa a la izquierda cuando el cursor está en la mitad derecha.
4. **Ajuste visual** — Afinar `RADIUS`, `ZOOM`, grosor del retículo y tipografía de coordenadas.
5. **Test manual** — Verificar en el flujo completo de selección de los 8 keypoints con un vídeo real.
