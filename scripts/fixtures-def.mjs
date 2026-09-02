/**
 * Synthetic corpus definitions. All content is invented for testing purposes
 * and imitates (without copying) the style of Spanish financial-regulatory
 * documents: circulars, resolutions, financial reports.
 *
 * Each fixture defines:
 * - `chrome`: repeated page header/footer text (layout noise),
 * - `blocks`: the *reference* (desktop-parser-shaped) block list,
 * - `gold` (optional): manually authored spoken text for G3a experiments,
 *   keyed by index into `blocks`.
 *
 * The generator turns these into: PDFs (for browser extraction), reference
 * JSON exports (G2 baseline / G3a gold carrier) and gold JSON files.
 */

export const fixtures = [
  {
    id: "nested-regulation-01",
    title: "Circular ficticia 1/2024",
    category: "nested-regulation",
    description:
      "Nested legal numbering, article references, exceptions, obligations, percentages, EUR amounts, numeric dates, BOE citation, T+2 settlement.",
    chrome: {
      header: "Circular 1/2024, de 12 de junio (documento de prueba)",
      footer: "CNMV — documento de prueba no oficial",
    },
    blocks: [
      {
        type: "heading",
        page: 1,
        text: "CIRCULAR 1/2024, DE 12 DE JUNIO, POR LA QUE SE ESTABLECEN OBLIGACIONES DE INFORME (DOCUMENTO DE PRUEBA)",
      },
      {
        type: "paragraph",
        page: 1,
        text: "La presente Circular tiene carácter íntegramente ficticio y se publica exclusivamente con fines de evaluación técnica. No constituye una reproducción de ninguna disposición real.",
      },
      { type: "heading", page: 1, text: "CAPÍTULO I. OBJETO Y ÁMBITO DE APLICACIÓN" },
      {
        type: "paragraph",
        page: 1,
        text: "Artículo 1. Objeto. La presente Circular establece las obligaciones de información periódica de las entidades de crédito en relación con sus activos ponderados por riesgo.",
      },
      {
        type: "paragraph",
        page: 1,
        text: "Artículo 2. Ámbito de aplicación. Será de aplicación a las entidades recogidas en el art. 57.1.b) de la Ley 47/2003, de 26 de noviembre, publicada en el BOE núm. 288, de 2 de diciembre de 2003, sin perjuicio de lo dispuesto en el apartado 3.",
      },
      {
        type: "paragraph",
        page: 1,
        text: "No obstante, quedarán exentas las entidades a que se refiere el apartado 3, salvo que superen un ratio de solvencia del 8,5 % durante dos ejercicios consecutivos.",
      },
      { type: "heading", page: 2, text: "CAPÍTULO II. INFORMACIÓN PERIÓDICA" },
      { type: "paragraph", page: 2, text: "Artículo 5. Información periódica." },
      {
        type: "paragraph",
        page: 2,
        text: "1.º Las entidades deberán remitir la información antes del día 15/07/2024 y, a más tardar, a las 14:00, hora peninsular.",
      },
      {
        type: "list-item",
        page: 2,
        text: "a) El umbral máximo será de 1.234.567,89 euros.",
      },
      {
        type: "list-item",
        page: 2,
        text: "b) El tipo aplicable será el resultado de incrementar el EURIBOR a 12 meses en 25 pb.",
      },
      {
        type: "paragraph",
        page: 2,
        text: "2.º Los importes superiores a 500.000 EUR deberán notificarse, además, en un plazo de T+2 días hábiles, siempre que el contrato se haya celebrado con posterioridad al 1 de enero de 2024.",
      },
      { type: "heading", page: 3, text: "ANEXO I. MODELO DE INFORME" },
      {
        type: "table-cell",
        page: 3,
        text: "Concepto: Fondo para intermedios financieros. Importe: 3.500,00 euros.",
      },
      {
        type: "table-cell",
        page: 3,
        text: "Concepto: Comisiones variables. Importe: 12,75 % del resultado.",
      },
      {
        type: "paragraph",
        page: 3,
        text: "El modelo de informe deberá presentarse conforme al Anexo I, que se publica en el sitio web del organismo. No podrá utilizarse el modelo del ejercicio 2023.",
      },
      {
        type: "footnote",
        page: 3,
        text: "(1) Los porcentajes se calcularán sobre el balance auditado a 31-12-2023.",
      },
    ],
    gold: [
      {
        blockIndex: 4,
        spoken:
          "Artículo 2. Ámbito de aplicación. Será de aplicación a las entidades recogidas en el artículo cincuenta y siete, apartado uno, letra b, de la Ley cuarenta y siete, dos mil tres, de veintiséis de noviembre, publicada en el Boletín Oficial del Estado número doscientos ochenta y ocho, de dos de diciembre de dos mil tres, sin perjuicio de lo dispuesto en el apartado tres.",
      },
      {
        blockIndex: 5,
        spoken:
          "No obstante, quedarán exentas las entidades a que se refiere el apartado tres, salvo que superen un ratio de solvencia del ocho coma cinco por ciento durante dos ejercicios consecutivos.",
      },
      {
        blockIndex: 8,
        spoken:
          "Punto primero. Las entidades deberán remitir la información antes del quince de julio de dos mil veinticuatro y, a más tardar, a las catorce horas, hora peninsular.",
      },
      {
        blockIndex: 9,
        spoken:
          "Letra a. El umbral máximo será de un millón doscientos treinta y cuatro mil quinientos sesenta y siete euros con ochenta y nueve céntimos.",
      },
      {
        blockIndex: 11,
        spoken:
          "Punto segundo. Los importes superiores a quinientos mil euros deberán notificarse, además, en un plazo de dos días hábiles después de la fecha de operación, siempre que el contrato se haya celebrado con posterioridad al uno de enero de dos mil veinticuatro.",
      },
      {
        blockIndex: 10,
        spoken:
          "Letra be. El tipo aplicable será el resultado de incrementar el euríbor a doce meses en veinticinco puntos básicos.",
      },
      {
        blockIndex: 15,
        spoken:
          "El modelo de informe deberá presentarse conforme al Anexo uno, que se publica en el sitio web del organismo. No podrá utilizarse el modelo del ejercicio dos mil veintitrés.",
      },
      {
        blockIndex: 16,
        spoken:
          "Nota uno. Los porcentajes se calcularán sobre el balance auditado a treinta y uno de diciembre de dos mil veintitrés.",
      },
    ],
  },
  {
    id: "financial-report-01",
    title: "Informe financiero ficticio",
    category: "financial",
    description:
      "Financial abbreviations, ISIN/LEI identifiers, basis points, euro millions, ranges, acronyms.",
    chrome: {
      header: "Informe de situación (sintético)",
      footer: "Página confidencial de prueba",
    },
    blocks: [
      {
        type: "heading",
        page: 1,
        text: "INFORME DE SITUACIÓN PATRIMONIAL — TERCER TRIMESTRE DE 2025",
      },
      {
        type: "paragraph",
        page: 1,
        text: "El volumen total de operaciones ascendió a 47.408 millones de euros, lo que supone un incremento del 3,75 % respecto al trimestre anterior.",
      },
      {
        type: "paragraph",
        page: 1,
        text: "La cartera de renta fija incluye el ISIN ES0123456789, emitido al amparo del Programa de pagarés, con un nominal de 250.000 EUR.",
      },
      {
        type: "paragraph",
        page: 1,
        text: "El identificador de la contraparte principal es el LEI VAVR88822QQ763F4A823. La entidad deberá conservar la trazabilidad de las liquidaciones T+1 durante los próximos 10–15 años.",
      },
      {
        type: "paragraph",
        page: 1,
        text: "El margen de intereses se situó en 0,50 €, un 12 % por debajo de la previsión del BCE para el área de la UE.",
      },
      {
        type: "list-item",
        page: 1,
        text: "— Provisiones: 2.345,67 euros.",
      },
      {
        type: "list-item",
        page: 1,
        text: "— Ratio de eficiencia: 54,3 %.",
      },
    ],
  },
  {
    id: "extraction-artifacts-01",
    title: "Artefactos de extracción",
    category: "extraction-artifacts",
    description:
      "Repeated chrome on every page, stray whitespace runs and hyphenated line breaks typical of PDF text extraction.",
    chrome: {
      header: "B O L E T I N   O F I C I A L   D E L   E S T A D O",
      footer: "www BOE   ejemplo   es — página",
    },
    blocks: [
      { type: "heading", page: 1, text: "RESOLUCIÓN DE PRUEBA" },
      {
        type: "paragraph",
        page: 1,
        text: "El  procedimiento  sancionador  se  iniciará  de  oficio,  salvo  que  el  interesado  aporte  alegaciones  en  el  plazo  de  quince  días  hábiles.",
      },
      {
        type: "paragraph",
        page: 1,
        text: "La resolución podrá ser inter- puesta ante el mismo órgano que la hubiera dictado en el plazo de un mes desde el día siguiente a su notificación.",
      },
      { type: "heading", page: 2, text: "SEGUNDO. RÉGIMEN RECURSORIO" },
      {
        type: "paragraph",
        page: 2,
        text: "Contra la presente resolución, que no pone fin a la vía administrativa, podrá interponerse recurso de alzada en el plazo de un mes, de conformidad con lo establecido en los artículos 121 y 122 de la Ley 39/2015.",
      },
    ],
  },
  {
    id: "simple-01",
    title: "Documento simple",
    category: "native-simple",
    description:
      "Clean two-page document with minimal structure, used as the baseline sanity check and for end-to-end tests.",
    chrome: {},
    blocks: [
      { type: "heading", page: 1, text: "NOTA INFORMATIVA" },
      {
        type: "paragraph",
        page: 1,
        text: "Esta nota es un documento de prueba completamente ficticio. Su objetivo es verificar el flujo de extracción y reproducción.",
      },
      {
        type: "paragraph",
        page: 1,
        text: "El texto contiene un número cualquiera, 42, y una fecha de muestra, 3 de mayo de 2026.",
      },
      {
        type: "paragraph",
        page: 2,
        text: "La segunda página añade un párrafo adicional para comprobar el orden de lectura entre páginas.",
      },
    ],
  },
];
