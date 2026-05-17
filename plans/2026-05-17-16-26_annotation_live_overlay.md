# Plan: Proyección en vivo de líneas de pista durante la anotación

## Motivación

Durante el paso de anotación el usuario coloca los puntos clave sobre el frame de vídeo
uno a uno. El único feedback actual es el badge de error de reproyección (visible desde
≥ 4 puntos). La superposición de líneas verdes proyectadas sobre el frame solo aparece
en el paso "Validar", que es posterior y separado.

El objetivo es mostrar esa misma superposición **dentro del canvas de anotación a medida
que se van colocando puntos**, de modo que el usuario pueda ver en tiempo real si cada
nuevo punto está mejorando o empeorando la proyección. Esto cierra el bucle de
retroalimentación: los errores se detectan durante la anotación, no al terminarla.

---

## Infraestructura existente (no se añade nada nuevo)

| Qué | Dónde |
|---|---|
| Cálculo en vivo de H | `AnnotationTool.tsx` — `liveResult` (useMemo, líneas 31–41): ya se recalcula en cada cambio de puntos |
| Proyección de líneas de pista | `ValidationView.tsx` líneas 38–52 — código de dibujo exacto a reutilizar |
| `applyH(H, x, y)` | `src/lib/homographyDLT.ts` — proyecta un punto real → imagen usando H⁻¹ |
| `invert3(H)` | `src/lib/homographyDLT.ts` — inversa de matriz 3×3 |
| `COURT_LINES` | `src/lib/courtKeypoints.ts` — 8 segmentos de línea en coordenadas reales |

H ya se calcula en vivo en `AnnotationTool` pero **no se pasa a `AnnotationCanvas`**.
`AnnotationCanvas` solo dibuja marcadores de puntos y segmentos de modo imaginario.

---

## Implementación

### 1. `src/components/AnnotationCanvas.tsx`

**Nueva prop:**
```ts
interface Props {
  // …props existentes…
  liveH?: Mat3 | null
}
```

**Nuevas importaciones:**
```ts
import { applyH, invert3, type Mat3 } from '../lib/homographyDLT'
import { COURT_LINES } from '../lib/courtKeypoints'
```

**Nuevo paso de dibujo** dentro del `useEffect` del canvas, después del paso de
marcadores de puntos (Paso 2) y antes del paso de lupa (Paso 3):

```ts
// Previsualización en vivo de las líneas de pista
if (liveH) {
  const H_inv = invert3(liveH)
  if (H_inv) {
    ctx.save()
    ctx.lineWidth   = Math.max(1.5, frame.width / 700)
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.45)'
    ctx.shadowColor = 'rgba(74, 222, 128, 0.25)'
    ctx.shadowBlur  = 4
    for (const [[x1, y1], [x2, y2]] of COURT_LINES) {
      const [u1, v1] = applyH(H_inv, x1, y1)
      const [u2, v2] = applyH(H_inv, x2, y2)
      ctx.beginPath()
      ctx.moveTo(u1, v1)
      ctx.lineTo(u2, v2)
      ctx.stroke()
    }
    ctx.restore()
  }
}
```

Opacidad `0.45` (frente a `0.85` en ValidationView) señala "previsualización en vivo"
y no una validación definitiva. Añadir `liveH` al array de dependencias del `useEffect`.

### 2. `src/components/AnnotationTool.tsx`

Pasar la H en vivo a `AnnotationCanvas`:

```tsx
<AnnotationCanvas
  {/* …props existentes… */}
  liveH={liveResult?.H ?? null}
/>
```

No se modifica ningún otro fichero.

---

## Decisiones de diseño

- **Sin umbral de activación:** la superposición aparece en cuanto H es calculable
  (≥ 4 puntos no degenerados). Una superposición visualmente incorrecta con pocos
  puntos es en sí misma información útil para el usuario.
- **ValidationView sin cambios:** conserva su superposición a opacidad completa y con
  sombra más intensa.
- **Badge de error de reproyección sin cambios.**
- **Orden de dibujo:** la superposición se renderiza antes de los marcadores de puntos,
  de modo que los círculos y etiquetas siempre quedan encima.

---

## Ficheros a modificar

| Fichero | Cambio |
|---|---|
| `src/components/AnnotationCanvas.tsx` | Añadir prop `liveH` + paso de dibujo |
| `src/components/AnnotationTool.tsx` | Pasar `liveResult?.H` a AnnotationCanvas |

---

## Verificación

1. `npm run dev` en `homography-tool/`.
2. Cargar un vídeo, capturar un frame, entrar en el paso de anotación.
3. Marcar 4+ puntos clave — debe aparecer una superposición verde tenue que se actualiza
   con cada punto nuevo o movido.
4. Comprobar que la superposición es visualmente más suave que la del paso Validar.
5. Comprobar que los círculos y etiquetas de los puntos se renderizan encima de la
   superposición.
6. Mover un punto existente — la superposición debe actualizarse de inmediato.
