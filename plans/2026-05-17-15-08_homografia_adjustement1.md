# Plan: Esquinas imaginarias (fuera de frame)

## Problema

Las 4 esquinas de la pista de padel son los puntos de referencia más fiables para la homografía,
pero con frecuencia una o varias de ellas quedan fuera del encuadre (recortadas por el ángulo de
la cámara, la pared de cristal, o el campo visual limitado). Si el usuario simplemente no puede
clicar sobre esa esquina, tiene que descartar ese keypoint y depender de menos correspondencias,
lo que reduce la precisión de la homografía.

El objetivo de este ajuste es permitir que el usuario indique la posición de una esquina aunque
no sea visible en el frame, deduciéndola a partir de las líneas visibles que convergerían en ese
punto.

---

## Concepto: intersección de dos segmentos visibles

Una esquina de la pista es la intersección de dos líneas rectas (lateral + línea de fondo, por
ejemplo). Aunque la esquina esté fuera de frame, las dos líneas que la forman sí son parcialmente
visibles. Si el usuario define un segmento sobre cada una de esas líneas, la herramienta calcula
el punto de intersección algebraicamente.

```
Frame visible
┌────────────────────────┐
│  \                     │   ← lateral de la pista (visible)
│   \                    │
│    \                   │
│─────────────────────   │   ← línea de fondo (visible)
│                        │
└────────────────────────┘
         \
          ✕  ← esquina imaginaria (fuera de frame)
```

El usuario traza dos segmentos sobre las líneas visibles; la herramienta calcula ✕ y lo usa como
keypoint en la homografía exactamente igual que cualquier otro punto.

---

## Flujo de usuario (UX)

### Marcar un punto normal

Sin cambios respecto al flujo actual: clic sobre el canvas → punto colocado.

### Marcar una esquina imaginaria

1. En la lista de keypoints pendientes, el punto actual muestra un botón secundario:
   **"Fuera de frame"** (o icono de punto con flecha saliente).

2. Al activarlo, el punto entra en modo **"Esquina imaginaria"**.

3. El canvas muestra instrucciones: _"Traza un segmento sobre la primera línea visible"_.
   El cursor cambia a una cruz de precisión.

4. El usuario hace clic dos veces para definir el primer segmento (sobre la línea lateral, por
   ejemplo). La línea se prolonga como guía con trazo discontinuo hasta el borde del canvas.

5. El canvas muestra: _"Ahora traza un segmento sobre la segunda línea visible"_.

6. El usuario hace clic dos veces para definir el segundo segmento (sobre la línea de fondo).
   También se prolonga como guía discontinua.

7. La herramienta calcula la intersección y la muestra con un marcador especial fuera del canvas
   (o en el borde si queda parcialmente visible). Se confirma automáticamente o con un botón
   **"Confirmar esquina"**.

8. Si las líneas son casi paralelas (ángulo < 5°), se muestra un aviso:
   _"Las líneas son casi paralelas. La intersección puede ser muy imprecisa."_

### Corrección posterior

- El punto imaginario puede editarse en cualquier momento volviendo a activar el modo y
  redibujando los segmentos.
- Los cuatro segmentos (dos por punto) se guardan en el estado junto con el punto calculado,
  para que el usuario pueda ajustarlos arrastrando los extremos.

---

## Representación visual

| Elemento | Visual |
|---|---|
| Punto normal marcado | Círculo sólido de color del keypoint |
| Punto imaginario | Círculo con borde discontinuo + icono de "fuera de frame" |
| Segmentos de definición | Línea delgada del color del keypoint, trazo continuo en la parte visible |
| Prolongación de la línea | Trazo discontinuo hasta el borde del canvas |
| Punto de intersección fuera de canvas | Marcador en el borde del canvas con una flecha indicando la dirección y distancia estimada ("≈ 120 px fuera") |
| Punto de intersección dentro del canvas | Igual que un punto normal pero con borde discontinuo |

El diagrama SVG de la pista (panel derecho) muestra el punto imaginario con el mismo marcador
especial para distinguirlo de los puntos confirmados visualmente.

---

## Implementación técnica

### Estado

```ts
type NormalKeypoint = {
  kind: 'normal';
  img: [number, number];  // coordenadas en píxeles del canvas
};

type ImaginaryKeypoint = {
  kind: 'imaginary';
  segmentA: [[number, number], [number, number]];  // dos clics sobre línea 1
  segmentB: [[number, number], [number, number]];  // dos clics sobre línea 2
  img: [number, number];  // intersección calculada (puede ser negativa o > tamaño canvas)
};

type Keypoint = NormalKeypoint | ImaginaryKeypoint;
```

### Cálculo de la intersección

La intersección de dos líneas en coordenadas homogéneas es una operación exacta:

```ts
function lineFromSegment(
  [x1, y1]: [number, number],
  [x2, y2]: [number, number]
): [number, number, number] {
  // Representación homogénea de la línea: l = p1 × p2
  return [
    y1 - y2,
    x2 - x1,
    x1 * y2 - x2 * y1,
  ];
}

function intersect(
  segA: [[number, number], [number, number]],
  segB: [[number, number], [number, number]]
): [number, number] | null {
  const lA = lineFromSegment(...segA);
  const lB = lineFromSegment(...segB);
  // Intersección: p = lA × lB
  const [a, b, c] = [
    lA[1] * lB[2] - lA[2] * lB[1],
    lA[2] * lB[0] - lA[0] * lB[2],
    lA[0] * lB[1] - lA[1] * lB[0],
  ];
  if (Math.abs(c) < 1e-8) return null;  // líneas paralelas
  return [a / c, b / c];
}
```

El resultado `[x, y]` puede tener valores negativos o mayores que el tamaño del canvas: eso es
correcto. `cv.findHomography` acepta puntos fuera de los límites de la imagen.

### Validación de ángulo

```ts
function angleBetweenSegments(
  segA: [[number, number], [number, number]],
  segB: [[number, number], [number, number]]
): number {
  const dirA = [segA[1][0] - segA[0][0], segA[1][1] - segA[0][1]];
  const dirB = [segB[1][0] - segB[0][0], segB[1][1] - segB[0][1]];
  const dot = dirA[0] * dirB[0] + dirA[1] * dirB[1];
  const magA = Math.hypot(...dirA);
  const magB = Math.hypot(...dirB);
  return Math.acos(Math.abs(dot) / (magA * magB)) * (180 / Math.PI);
}
// Si angleBetweenSegments(...) < 5 → mostrar aviso
```

### Representación en el canvas de los segmentos fuera del área visible

Los segmentos se prolongan hasta los bordes del canvas usando clip y el mismo `lineTo`. La
prolongación discontinua se renderiza con `ctx.setLineDash([6, 4])`.

Para el marcador fuera del canvas, se dibuja en el borde más cercano con una flecha hacia fuera y
el texto con la distancia aproximada al punto real.

---

## Componentes afectados

| Componente | Cambio |
|---|---|
| `AnnotationCanvas` | Añadir sub-estado de modo imaginario con captura de 4 clics; renderizado de segmentos y prolongaciones |
| `PointQueue` | Mostrar badge "fuera de frame" en el punto activo; botón para activar el modo |
| `CourtDiagram` | Marcar el punto con icono especial en el SVG |
| `HomographyEngine` | Sin cambios: acepta cualquier coordenada de píxel, incluyendo valores fuera del canvas |
| Tipos compartidos (`types.ts`) | Añadir `ImaginaryKeypoint` al tipo `Keypoint` |
| JSON exportado | Añadir campo `imaginary: true` y `segments` en el keypoint correspondiente |

---

## JSON de exportación (extensión)

```json
{
  "keypoints": [
    { "id": "A", "img": [-42, -18], "real": [0, 0], "imaginary": true,
      "segments": {
        "a": [[120, 310], [85, 420]],
        "b": [[30, 380], [200, 385]]
      }
    },
    { "id": "B", "img": [834, 22], "real": [10, 0] }
  ]
}
```

---

## Casos límite

- **Líneas casi paralelas** (< 5°): aviso al usuario; no bloquear, pero alertar de baja precisión.
- **Intersección muy lejana** (> 3× la dimensión del frame): advertir que el punto está muy
  alejado y que el error de reproyección puede ser elevado.
- **Solo una línea visible**: si el usuario no puede trazar ambos segmentos, debe saltarse ese
  keypoint. No forzar el flujo.
- **Punto imaginario que cae dentro del canvas**: tratar igual que un punto normal pero conservar
  los segmentos por si el usuario quiere ajustar.

---

## Fases de implementación

1. **Tipos y estado** — Extender `Keypoint` con `ImaginaryKeypoint`; adaptar el reducer/estado.
2. **Lógica de intersección** — Implementar y testear `intersect` y `angleBetweenSegments`.
3. **UI del canvas** — Sub-estados de captura de 4 clics; renderizado de segmentos y prolongaciones.
4. **PointQueue** — Botón "Fuera de frame"; badge visual en el punto.
5. **CourtDiagram** — Icono de punto imaginario en el SVG.
6. **Exportación** — Incluir `imaginary` y `segments` en el JSON.
7. **Validación** — Comprobar que `findHomography` produce resultados coherentes con puntos fuera del canvas.
