# Plan: Lupa v2 — sigue al cursor y soporte táctil

## Cambios respecto a la implementación actual

| Aspecto | v1 (actual) | v2 (nuevo) |
|---|---|---|
| Posición de la lupa | Esquina fija (top-right / top-left) | Flotante sobre el cursor/dedo |
| Cursor del sistema | `none` al colocar punto | Siempre `crosshair` |
| Eventos táctiles | No soportados | `touchstart`, `touchmove`, `touchend` |
| Visibilidad de la lupa | Solo en modo normal (`currentKeypoint && !imaginaryMode`) | Siempre que haya posición activa (`currentKeypoint` o `imaginaryMode`) |

---

## 1. Nueva posición de la lupa

La lupa sigue al cursor y se centra **directamente encima** de él, con un pequeño hueco para que la
punta del cursor siga visible.

```
          ┌────────────────┐
          │   ╋ (retículo) │  ← lupa, centro en (mouse.u, mouse.v - R - GAP)
          └────────────────┘
                  ↑ GAP
                  ✛  ← crosshair del sistema (siempre visible)
```

### Cálculo del centro de la lupa

```ts
const GAP = 8  // px en pantalla entre borde inferior de la lupa y el cursor

// Posición vertical
const lyNormal = mouse.v - R - GAP * scale  // encima del cursor
const lyFlipped = mouse.v + R + GAP * scale // debajo si no cabe arriba

const ly = lyNormal - R < 0 ? lyFlipped : lyNormal

// Posición horizontal: centrada con el cursor, clampeada a los bordes del canvas
const lx = Math.max(R + margin, Math.min(canvasW - R - margin, mouse.u))
```

Cuando el cursor está muy cerca del borde superior (no hay espacio para la lupa encima), la lupa
se refleja hacia abajo. En los bordes laterales, el centro de la lupa se clampa para no salirse
del canvas.

El label de coordenadas:
- Si la lupa está encima del cursor: label se imprime **encima** del círculo (`ly - R - labelOffset`), para no tapar el cursor.
- Si la lupa está debajo del cursor: label se imprime **debajo** del círculo (`ly + R + labelOffset`).

---

## 2. Cursor siempre `crosshair`

La lógica de cursor se simplifica. Ya no se usa `cursor: none`:

```ts
const cursor = dragId ? 'grabbing' : (imaginaryMode || currentKeypoint) ? 'crosshair' : 'default'
```

El cursor del sistema y la lupa coexisten: el cursor indica el punto exacto de clic, la lupa
amplía la zona para afinarlo visualmente.

---

## 3. La lupa también se muestra en modo imaginario

Actualmente la lupa solo aparece en modo normal. Con v2, aparece en cualquier modo activo, ya que
la precisión es igualmente importante al definir los segmentos de una esquina imaginaria.

Condición en el draw effect:

```ts
if ((currentKeypoint || imaginaryMode) && mousePos) {
  drawLoupe(ctx, mousePos, loadedImg, W, H, scale)
}
```

---

## 4. Soporte táctil

### Mapeo de eventos

| Gesto táctil | Equivalente mouse | Acción |
|---|---|---|
| `touchstart` (1 dedo) | `mousedown` | Inicia drag si hay punto cerca; si no, registra inicio de posible tap |
| `touchmove` (1 dedo) | `mousemove` | Actualiza `mousePos` (muestra lupa); si hay drag activo, mueve el punto |
| `touchend` | `mouseup` + clic condicional | Si no hubo movimiento significativo (< 8 px), cuenta como clic (coloca punto); limpia `mousePos` |

### Umbral de movimiento para distinguir tap de scroll

Un `touchmove` con desplazamiento < 8 px desde el `touchstart` se considera tap al soltar. Si
supera 8 px, se considera arrastre (drag de punto existente o simplemente scroll).

```ts
const touchStart = useRef<{ x: number; y: number; id: number } | null>(null)
const TAP_THRESHOLD = 8  // px en coordenadas de pantalla
```

### `preventDefault` para suprimir scroll

Dentro de `touchmove` hay que llamar `e.preventDefault()` para evitar que el navegador haga scroll
de la página mientras el usuario arrastra sobre el canvas. Esto requiere que el listener sea
registrado como **non-passive**. En React los event handlers en JSX son pasivos por defecto, por
lo que los listeners táctiles se registran con `addEventListener` en un `useEffect`:

```ts
useEffect(() => {
  const canvas = canvasRef.current!
  const onTm = (e: TouchEvent) => { e.preventDefault(); handleTouchMove(e) }
  canvas.addEventListener('touchmove', onTm, { passive: false })
  return () => canvas.removeEventListener('touchmove', onTm)
}, [/* deps */])
```

`touchstart` y `touchend` pueden seguir siendo JSX handlers ya que no necesitan `preventDefault`.

### Extracción de coordenadas táctiles

```ts
const toFrameCoordsFromTouch = (touch: React.Touch): ImgPoint => {
  const canvas = canvasRef.current!
  const rect = canvas.getBoundingClientRect()
  return {
    u: (touch.clientX - rect.left) * (frame.width  / rect.width),
    v: (touch.clientY - rect.top)  * (frame.height / rect.height),
  }
}
```

### Handlers táctiles

```ts
const onTouchStart = (e: React.TouchEvent) => {
  const touch = e.changedTouches[0]
  touchStart.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier }
  const pt = toFrameCoordsFromTouch(touch)
  setMousePos(pt)
  // Si hay un punto cerca, preparar drag
  const hit = findNear(touch.clientX, touch.clientY)
  if (hit) setDragId(hit)
}

// handleTouchMove — registrado como non-passive (ver arriba)
const handleTouchMove = (e: TouchEvent) => {
  const touch = [...e.changedTouches].find(t => t.identifier === touchStart.current?.id)
  if (!touch) return
  const pt = toFrameCoordsFromEvent(touch.clientX, touch.clientY)
  setMousePos(pt)
  if (dragId) onPointMoved(dragId, pt)
}

const onTouchEnd = (e: React.TouchEvent) => {
  const touch = e.changedTouches[0]
  if (touchStart.current) {
    const dx = touch.clientX - touchStart.current.x
    const dy = touch.clientY - touchStart.current.y
    const moved = Math.sqrt(dx * dx + dy * dy)
    if (moved < TAP_THRESHOLD && !dragId) {
      // Cuenta como clic — reutiliza la misma lógica de onMouseDown
      const pt = toFrameCoordsFromTouch(touch)
      handlePlacement(pt)
    }
  }
  setDragId(null)
  setMousePos(null)
  touchStart.current = null
}
```

`handlePlacement(pt)` extrae la lógica de colocación/modo-imaginario de `onMouseDown` en una
función reutilizable, llamada tanto desde `onMouseDown` como desde `onTouchEnd`.

---

## Componentes afectados

| Fichero | Cambio |
|---|---|
| `src/lib/drawLoupe.ts` | Reemplazar lógica de esquina fija por posición flotante sobre el cursor con flip vertical y clamp horizontal |
| `src/components/AnnotationCanvas.tsx` | Eliminar `cursor: none`; simplificar lógica de cursor; ampliar condición de la lupa a imaginary mode; añadir `onTouchStart`/`onTouchEnd` JSX handlers y `useEffect` para `touchmove` non-passive; extraer `handlePlacement` |

---

## Fases de implementación

1. **`drawLoupe.ts`** — Nueva lógica de posición flotante (flip + clamp).
2. **Cursor y condición de lupa** — Simplificar cursor; mostrar lupa en ambos modos.
3. **Extraer `handlePlacement`** — Desacoplar lógica de clic de `onMouseDown`.
4. **Handlers táctiles** — `onTouchStart`, `handleTouchMove` (non-passive), `onTouchEnd`.
5. **Test** — Verificar en Chrome DevTools con emulación táctil y en dispositivo real.
