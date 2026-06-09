# Rotación Bonos — Contexto del proyecto

## Qué hace la app

Herramienta web para analizar el **ratio de precio entre pares de bonos soberanos hard dollar argentinos** (GD vs AL) usando **Bandas de Bollinger**. Permite detectar oportunidades de rotación: cuándo un bono de la misma duración está caro/barato respecto al otro.

- Cuatro pares analizados: GD30/AL30 · GD35/AL35 · GD38/AE38 · GD41/AL41
- Señales: **Rotar a GD** (ratio ≥ banda superior) · **Rotar a AL** (ratio ≤ banda inferior) · Neutro
- La tab GD30/AL30 además incluye una sección **Intraday** con datos tick-by-tick y auto-refresh

---

## Stack técnico

- **HTML + CSS + JS vanilla** — sin frameworks, sin bundler
- **Chart.js 4.4.1** (CDN) — único tercero, para gráficos de línea
- **Inter** (Google Fonts) — tipografía
- **Google Sheets** como backend de datos — CSVs públicos, sin autenticación
- Deploy en **Vercel** (estático, SPA rewrite via `vercel.json`)

---

## Estructura de archivos

```
rotacion-bonos/
├── index.html          Estructura, CDN Chart.js + Inter, 4 tab-panels vacíos
├── css/
│   └── style.css       Dark theme completo + estilos intraday/loading/error
├── js/
│   └── app.js          Toda la lógica (fetch, parse, Bollinger, Chart.js, UI)
├── vercel.json         { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
└── CLAUDE.md           Este archivo
```

> **No existe `data.js`** — los datos se fetchean en tiempo real desde Google Sheets.
> Fue eliminado en la segunda iteración del proyecto.

---

## URLs de los CSVs

**Base común:**
```
https://docs.google.com/spreadsheets/d/e/2PACX-1vTuuPzwvPZac06ggk2VPnNrP8cnTXEx2qjcnoWXO59Lrvb-4ZpXwj6Zv2uh-Ss3ay3Sm2iKUP7X26KP/pub?single=true&output=csv&gid=
```

| Par / Hoja     | GID          |
|----------------|-------------|
| GD30/AL30      | 1238880052  |
| GD35/AL35      | 1993257442  |
| GD38/AE38      | 925690249   |
| GD41/AL41      | 1751658078  |
| Intraday       | 1764500972  |

URL completa de ejemplo: `BASE_URL + "1238880052"`

---

## Estructura real del CSV histórico

**Crítico:** hay una **columna vacía en col[0]**. Los índices reales son:

| Índice | Contenido                        |
|--------|----------------------------------|
| 0      | Vacío (ignorar siempre)          |
| 1      | Fecha — formato `d/m` o `dd/mm`  |
| 2      | Precio bono 1 (ej: 92900)        |
| 3      | Precio bono 2 (ej: 91500)        |
| 4      | Ratio — ej: `"2.30%"`            |

- El CSV llega **más reciente primero** → el parser invierte el array al final
- Las hojas tienen encabezados/notas de altura variable antes de los datos — **no skipear N filas fijas**
- El parser detecta filas de datos por el patrón `/^\d{1,2}\/\d{1,2}$/` en `cols[1]`
- Los precios están en unidades donde 92900 = precio 92.90 (dividir por 1000 para mostrar)
- El ratio ya viene como porcentaje (2.30 = 2.30%)

**Parser actual (en `parseHistorical`):**
```js
for (const row of csvText.split('\n')) {
  const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, '').replace('\r', ''));
  if (!/^\d{1,2}\/\d{1,2}$/.test(cols[1])) continue;
  const b1    = parseFloat(cols[2]);
  const b2    = parseFloat(cols[3]);
  const ratio = parseFloat((cols[4] || '').replace('%', '').replace(',', '.'));
  if (isNaN(b1) || isNaN(b2) || isNaN(ratio)) continue;
  data.push({ d: cols[1], b1, b2, r: ratio });
}
return data.reverse();
```

---

## Estructura real del CSV intraday

| Índice | Contenido                                                    |
|--------|--------------------------------------------------------------|
| 0      | Hora — formato `HH:MM:SS` exacto (ej: `"10:47:19"`)         |
| 1      | Precio GD30                                                  |
| 2      | Precio AL30                                                  |
| 3      | Ratio mid (número, ej: 1.53)                                 |
| 4      | GD→AL ejecutable (ratio con spread bid/ask para rotar GD→AL) |
| 5      | AL→GD ejecutable (ratio con spread bid/ask para rotar AL→GD) |

- El CSV llega **más reciente primero** → se invierte para graficar cronológicamente
- Header en fila 0: `Hora | GD30 | AL30 | Ratio | GD>AL | AL>GD`; fila 1: separador → se skipean con `.slice(2)`
- Las filas se filtran por regex `/^\d{2}:\d{2}:\d{2}$/` en col[0] + todos los campos 1–5 numéricos

---

## Lógica de Bollinger

```
Para cada punto i con período P y desvíos D:
  MM    = promedio de los últimos P ratios (o todos los disponibles si hay < P)
  σ     = desvío estándar poblacional (dividido por N, no N-1)
  Sup   = MM + D × σ
  Inf   = MM − D × σ
  Señal = ratio ≥ Sup → "Rotar a GD" (rojo)
          ratio ≤ Inf → "Rotar a AL" (verde)
          otherwise  → "Neutro" (gris)
```

- **Defaults**: período = 21, desvíos = 1.5
- **Rango sliders**: período 5–40, desvíos 0.5–3.0 (step 0.1)
- Cada tab recuerda sus propios valores de slider en `state.params[pairKey]`
- Si `n < period` (pocos datos), el último punto se computa igual con los `n` disponibles; el resto retorna `{mm: null, ...}` (ver fix de "lastBoll undefined")

---

## Auto-refresh intraday

- Intervalo: **60 segundos** (`setInterval(fetchAndRenderIntraday, 60_000)`)
- Arranca inmediatamente en `DOMContentLoaded`, independiente del fetch histórico
- Los datos **históricos NO hacen auto-refresh** — solo se fetchean al cargar la página
- El indicador visual muestra `● Actualizado HH:MM:SS` (verde) o `● Error: ...` (rojo)

**Por qué 60s y no menos:**
Google Sheets tarda entre 30–60 s en propagar cambios al CSV publicado.
Con menos de 60s se obtienen datos repetidos (la misma versión cacheada del CSV).
Usar 30s o menos es desperdiciar requests sin ganancia de frescura.

---

## Decisiones de diseño

| Decisión | Razón |
|----------|-------|
| Dark theme (`#0f1117`) | Estética de terminal financiera; reduce fatiga visual en sesiones largas |
| Chart.js vía CDN, no npm | Proyecto estático sin bundler; CDN es suficiente para el caso de uso |
| Sin frameworks | Dependencia cero aparte de Chart.js; facilita deploy y mantenimiento |
| `fill: 'end'` para banda superior | Rellena desde la línea hacia el tope del chart → zona roja sobre banda sup |
| `fill: 'start'` para banda inferior | Rellena desde la línea hacia el piso del chart → zona verde bajo banda inf |
| `fill: '+1'` en GD→AL (intraday) | Rellena entre GD→AL y AL→GD → spread ejecutable gris semitransparente |
| Destroy + recreate chart en cada render | Más simple que `chart.update()`; imperceptible en ~100 puntos |
| Fetch por par independiente (no `Promise.all`) | Cada par muestra su data ni bien llega, sin esperar al más lento |
| Lazy init de paneles | El HTML de cada tab se genera solo la primera vez que se visita |

---

## Bugs resueltos (no repetir)

### 1. `lastBoll is undefined` en `renderCards`

**Causa:** `computeBollinger` retornaba `{mm: null, ...}` para todos los puntos cuando `n < period`. El último punto quedaba con `signal: null`, y la desestructuración `const { signal } = lastBoll` explotaba.

**Fix:** Dos partes:
- `computeBollinger`: si `i === n-1` y `n < period`, no retorna null — computa igual con los `n` datos disponibles usando `ep = chunk.length` en vez de `period`
- `renderCards`: desestructuración defensiva: `const { signal = null, ... } = lastBoll ?? {}`; si `signal` es null, muestra "Sin datos suficientes" en gris

### 2. CSVs históricos parseando 0 filas válidas

**Causa 1 — Skip fijo de filas:** El parser original hacía `.slice(2)` asumiendo 2 filas de header. Las hojas reales tienen encabezados de altura variable.

**Fix:** Detección por patrón de fecha `/^\d{1,2}\/\d{1,2}$/` en la columna correspondiente, en vez de skip fijo.

**Causa 2 — Columna vacía en col[0]:** El CSV tiene una columna vacía al inicio que desplaza todos los índices en +1. El parser buscaba la fecha en `cols[0]` pero estaba en `cols[1]`.

**Fix:** Cambiar todos los índices: fecha → `cols[1]`, b1 → `cols[2]`, b2 → `cols[3]`, ratio → `cols[4]`.

**Diagnóstico usado:** `console.log('[CSV RAW primeras 10 lineas]', csvText.split('\n').slice(0, 10))` al inicio de `parseHistorical` para ver la estructura real antes de cualquier parsing. Eliminar este log después de diagnosticar.

### 3. Carriage return `\r` en celdas

**Causa:** Google Sheets exporta con line endings `\r\n`. Al hacer `.split('\n')` queda `\r` al final de la última celda de cada fila.

**Fix:** `.replace('\r', '')` en el map de celdas al parsear.
