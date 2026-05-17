# Plan: Valla en el diagrama cenital de la pista

## Motivación

El componente `CourtDiagram` muestra una vista cenital de la pista de pádel con las
líneas de juego, la red y los puntos clave. Sin embargo, la pista de pádel real está
completamente cerrada por paredes de cristal y valla metálica de malla. Al no aparecer
en el diagrama, la vista cenital da la impresión de ser un conjunto de líneas flotantes
en lugar de una pista acotada.

El objetivo es añadir la valla/cerramiento al diagrama para que refleje fielmente la
estructura física real.

---

## Estado actual

**Fichero:** `homography-tool/src/components/CourtDiagram.tsx`

- `viewBox` definido como `"-12 -12 ${W + 24} ${L + 24}"` — ya hay **12 unidades SVG
  (~1,2 m) de margen** en cada lado.
- Superficie verde: `<rect>` de `(0,0)` a `(100,200)`.
- Líneas blancas: contorno, red, líneas de saque y línea central de saque.
- No existe ningún elemento que represente la valla o el cerramiento.

En la pista de pádel real, la valla está exactamente en el límite de la superficie de
juego — no hay separación física entre la línea de fondo/lateral y la pared/valla.

---

## Opciones de representación

### Opción A — Rectángulo gris exterior (desplazado hacia fuera)

Dibujar un `<rect>` ligeramente fuera del contorno de la pista (p. ej. `x=-4 y=-4`,
`width=W+8 height=L+8`) con trazo gris y sin relleno.

- **Resultado visual:** Un marco gris fino alrededor de la pista, claramente separado
  de las líneas blancas de juego.
- **Ventajas:** Un solo elemento SVG, no solapa con las líneas existentes, se lee de
  inmediato como un cerramiento.
- **Inconvenientes:** Implica visualmente una pequeña separación entre la línea de
  fondo y la valla (convención esquemática, no realidad física). El margen ya existente
  de 12 unidades lo contiene sin problema.

### Opción B — Líneas grises coincidentes con el contorno

Superponer (o sustituir) las cuatro líneas blancas del contorno por líneas grises más
gruesas en las mismas coordenadas.

- **Resultado visual:** El contorno parece más pesado/oscuro para sugerir que es
  también una pared.
- **Ventajas:** Geométricamente exacto — la valla está en el límite de juego.
- **Inconvenientes:** Las líneas blancas se renderizan encima y el color gris apenas se
  distingue. Se pierde la distinción entre «línea de juego» y «valla». Confuso sin una
  entrada de leyenda adicional.

### Opción C — Líneas discontinuas / tramado a lo largo del perímetro

Dibujar las cuatro líneas del contorno dos veces: una vez en blanco (línea de juego
existente) y otra como línea discontinua o de puntos en gris, desplazada levemente,
para evocar la textura de malla metálica.

- **Resultado visual:** Sensación de malla/alambre en las paredes.
- **Ventajas:** Comunica la naturaleza física del material de la valla.
- **Inconvenientes:** Visualmente congestionado al tamaño reducido en que se renderiza
  el SVG. Requiere más elementos y es más difícil de leer.

### Opción D — Banda rellena entre dos rectángulos (zona de valla)

Dibujar un `<rect>` gris semitransparente ligeramente mayor que la pista y luego el
`<rect>` verde de la superficie encima, dejando visible una delgada banda gris como
«zona de valla».

- **Resultado visual:** Borde de color alrededor de la superficie verde.
- **Ventajas:** Rellena la zona de valla de forma limpia sin necesidad de líneas extra.
- **Inconvenientes:** El ancho de la banda hay que calibrarlo con cuidado para que no
  parezca simplemente un borde decorativo. El `rx` del rect verde necesita alinearse.

---

### Conclusión

Se recomienda la **Opción A**. Es la más sencilla de implementar (un único `<rect>`
antes de la superficie), visualmente inequívoca como cerramiento, y coherente con la
convención habitual en diagramas esquemáticos de pistas deportivas (p. ej. planos de
arquitectura donde el grosor de la pared se representa como un contorno exterior).

El pequeño desplazamiento hacia fuera es una convención aceptada: las líneas blancas
siguen marcando con precisión el límite de la superficie de juego, y la línea gris
exterior señala que el conjunto está cerrado.

**Parámetros de la Opción A:**
- Rect de valla: `x=-4, y=-4, width=W+8, height=L+8`
- Trazo: `#9ca3af` (Tailwind `gray-400`) — neutro, claramente distinto de una línea de juego
- Grosor de trazo: `1.5` unidades SVG
- Relleno: `none`
- Orden de render: después del fondo `bg-slate-800`, **antes** del `<rect>` verde de la
  superficie — la valla queda detrás de la pista visualmente.

El margen de 12 unidades en el `viewBox` contiene con holgura el desplazamiento de 4
unidades (~8 unidades de margen restante).

---

## Implementación

Solo se modifica un fichero:

**`homography-tool/src/components/CourtDiagram.tsx`**

1. Añadir la constante `FENCE_OFFSET = 4` junto a `S`, `W`, `L`.

2. Dentro del SVG, **antes** del comentario `{/* Court surface */}`, insertar:

   ```tsx
   {/* Fence enclosure */}
   <rect
     x={-FENCE_OFFSET} y={-FENCE_OFFSET}
     width={W + FENCE_OFFSET * 2} height={L + FENCE_OFFSET * 2}
     fill="none"
     stroke="#9ca3af" strokeWidth={1.5}
     rx={2}
   />
   ```

No hay cambios en `courtKeypoints.ts`, tipos ni otros componentes.

---

## Verificación

1. `npm run dev` en `homography-tool/`.
2. Abrir la herramienta en el navegador e inspeccionar el panel «Vista cenital de la
   pista».
3. Comprobar que aparece un borde gris alrededor de la superficie verde con separación
   visible de las líneas blancas de contorno.
4. Comprobar que los puntos clave y sus etiquetas no se ven afectados.
5. Comprobar que el rect de valla no desborda el `viewBox` (`-12 offset > FENCE_OFFSET=4` ✓).
