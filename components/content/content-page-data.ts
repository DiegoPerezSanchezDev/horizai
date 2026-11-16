export interface ContentSection {
  heading: string;
  paragraphs?: readonly string[];
  items?: readonly string[];
}

export interface ContentPageLink {
  href: string;
  label: string;
}

export interface ContentPageData {
  eyebrow: string;
  title: string;
  titleAccent: string;
  intro: string;
  sections: readonly ContentSection[];
  callout?: string;
  action?: ContentPageLink;
}

export const CONTENT_PAGES = {
  about: {
    eyebrow: "SOBRE HORIZAI",
    title: "Todo lo importante de la IA, ",
    titleAccent: "sin ruido.",
    intro: "HorizAI nace para reunir, contextualizar y explicar en español lo más importante que ocurre en inteligencia artificial en todo el mundo.",
    sections: [
      {
        heading: "Una mirada global, en español",
        paragraphs: [
          "La inteligencia artificial avanza en muchos lugares a la vez: laboratorios, universidades, empresas, organismos públicos y comunidades de desarrolladores. HorizAI ayuda a seguir ese movimiento sin tener que separar la señal del ruido de cada fuente.",
          "Nuestra cobertura conecta regiones, países y temas para que sea más sencillo entender qué está cambiando y por qué puede importar.",
        ],
      },
      {
        heading: "Claridad antes que volumen",
        paragraphs: [
          "Priorizamos una lectura clara, directa y útil. No buscamos llenar una página de titulares, sino ofrecer el contexto suficiente para que cada historia pueda entenderse por sí misma.",
        ],
        items: ["Cobertura global con perspectiva local.", "Explicaciones breves y comprensibles.", "Separación clara entre hechos, contexto y perspectivas."],
      },
      {
        heading: "Tecnología al servicio de entender",
        paragraphs: [
          "La tecnología nos permite ordenar señales, relacionar eventos y explorar la actividad de IA por regiones. El producto está pensado para facilitar la comprensión, no para sustituir la lectura crítica ni las fuentes originales.",
        ],
      },
      {
        heading: "Nuestro objetivo",
        paragraphs: [
          "Queremos ayudarte a mantenerte un paso adelante con una visión más completa de la IA: qué está ocurriendo, quién está impulsando el cambio y qué consecuencias puede tener.",
        ],
      },
    ],
  },
  methodology: {
    eyebrow: "METODOLOGÍA",
    title: "Cómo convertimos ",
    titleAccent: "señales en contexto.",
    intro: "Nuestro proceso editorial combina descubrimiento, verificación y explicación para ordenar la actividad global de inteligencia artificial.",
    sections: [
      {
        heading: "Nuestro flujo editorial",
        items: [
          "Descubrimiento de fuentes: localizamos anuncios, investigaciones, documentos y señales relevantes en distintas regiones.",
          "Agrupación de eventos: reunimos publicaciones que hablan del mismo hecho para evitar duplicidades y entender su evolución.",
          "Verificación: contrastamos los datos principales y comprobamos que las fuentes sean trazables.",
          "Redacción y traducción: resumimos la información en español con lenguaje claro, manteniendo los matices importantes.",
          "Clasificación: asignamos región, país, categoría y otros atributos que ayudan a explorar el ecosistema.",
          "Puntuación de relevancia: estimamos qué historias merecen mayor visibilidad según varios factores editoriales.",
          "Publicación: presentamos la historia con su contexto y enlaces a las fuentes originales cuando es posible.",
          "Correcciones: revisamos y actualizamos el contenido cuando aparece información nueva o detectamos un error.",
        ],
      },
      {
        heading: "Automatización con trazabilidad",
        paragraphs: [
          "Parte del procesamiento puede apoyarse en sistemas automatizados o herramientas de IA para descubrir, agrupar, traducir y clasificar información. Esa asistencia no elimina la necesidad de revisar el contexto ni de conservar el rastro hacia las fuentes.",
          "Cuando un dato no puede verificarse con suficiente claridad, debe presentarse con cautela o quedar fuera de la selección principal.",
        ],
      },
      {
        heading: "Cómo calculamos la relevancia",
        paragraphs: [
          "La relevancia no se reduce a una única métrica ni a una fórmula fija. Puede considerar una combinación de señales editoriales y de actividad, entre ellas:",
        ],
        items: ["Impacto potencial.", "Novedad del acontecimiento.", "Alcance geográfico o sectorial.", "Credibilidad y calidad de las fuentes.", "Repercusión económica.", "Tracción y conversación que genera."],
      },
      {
        heading: "Correcciones y transparencia",
        paragraphs: [
          "Si una historia cambia, se amplía o contiene un error, la corrección debe priorizar la claridad para el lector. La metodología seguirá evolucionando a medida que aprendamos del producto y de sus fuentes.",
        ],
      },
    ],
  },
  sources: {
    eyebrow: "FUENTES",
    title: "La información empieza en la ",
    titleAccent: "fuente original.",
    intro: "HorizAI prioriza materiales que permitan entender de dónde sale una afirmación y ampliar la información con contexto propio.",
    sections: [
      {
        heading: "Qué fuentes priorizamos",
        items: [
          "Fuentes oficiales y organismos públicos.",
          "Comunicados corporativos y páginas de producto.",
          "Documentación técnica y repositorios.",
          "Papers, preprints y publicaciones académicas.",
          "Medios tecnológicos y medios económicos con trayectoria.",
          "Universidades, laboratorios y centros de investigación.",
        ],
      },
      {
        heading: "Un ecosistema amplio",
        paragraphs: [
          "Según el tema, podemos consultar materiales de organizaciones como OpenAI, Anthropic, Google DeepMind, Meta AI, NVIDIA, Hugging Face, arXiv o la Comisión Europea, además de universidades, organismos públicos y medios especializados.",
          "Estos nombres son ejemplos del tipo de fuente que puede formar parte de una investigación; la selección concreta depende de cada historia.",
        ],
      },
      {
        heading: "Cómo usamos las fuentes",
        paragraphs: [
          "HorizAI no sustituye a la fuente original. Enlazamos a ella siempre que sea posible y podemos combinar varias referencias para explicar un mismo evento, especialmente cuando una sola fuente no cubre todo el contexto.",
          "El objetivo es que puedas leer un resumen accesible y, al mismo tiempo, comprobar o ampliar la información por tu cuenta.",
        ],
      },
    ],
  },
  contact: {
    eyebrow: "CONTACTO",
    title: "Hablemos sobre ",
    titleAccent: "lo que está cambiando.",
    intro: "Si tienes una corrección, una fuente que debamos revisar o una propuesta relacionada con HorizAI, puedes escribirnos.",
    action: { href: "mailto:hola@horizai.es", label: "hola@horizai.es" },
    sections: [
      {
        heading: "Motivos de contacto",
        items: ["Errores o correcciones.", "Prensa y solicitudes editoriales.", "Publicidad y propuestas comerciales.", "Colaboraciones.", "Sugerencias sobre el producto."],
      },
      {
        heading: "Una vía sencilla para el MVP",
        paragraphs: [
          "Por ahora no hay un formulario conectado ni un sistema de soporte automático. El correo anterior es un placeholder para preparar la experiencia y deberá sustituirse por un canal operativo antes del lanzamiento público.",
        ],
      },
    ],
  },
  privacy: {
    eyebrow: "PRIVACIDAD",
    title: "Una política clara para un ",
    titleAccent: "producto en evolución.",
    intro: "Esta política provisional explica qué datos podrían tratarse si determinadas funciones se habilitan en HorizAI y cómo revisaremos esas decisiones.",
    callout: "Documento provisional para el MVP. Debe revisarse antes del lanzamiento público.",
    sections: [
      {
        heading: "Qué datos podrían recogerse",
        paragraphs: [
          "En el estado actual del MVP no se ha habilitado un sistema de cuentas ni una base de datos de usuarios. Si en el futuro se incorporan formularios, cuentas, preferencias o suscripciones, se informará de forma concreta sobre los datos necesarios y su finalidad.",
        ],
      },
      {
        heading: "Cookies y analítica",
        paragraphs: [
          "Si se habilitan cookies no esenciales o herramientas de analítica, esta política deberá actualizarse para describirlas, explicar su finalidad y recoger las opciones de consentimiento que correspondan.",
        ],
      },
      {
        heading: "Contacto y futuras suscripciones",
        paragraphs: [
          "Los mensajes enviados por contacto podrían incluir datos identificativos y se utilizarían para responder a la solicitud. Una newsletter solo se contemplará si se implementa en el futuro con un mecanismo claro de alta y baja.",
        ],
      },
      {
        heading: "Derechos y contacto",
        paragraphs: [
          "Cuando exista tratamiento de datos personales, las personas usuarias podrán ejercer los derechos que correspondan según la normativa aplicable, incluyendo acceso, rectificación, supresión y oposición. El canal de contacto deberá definirse antes del lanzamiento.",
        ],
      },
    ],
  },
  terms: {
    eyebrow: "TÉRMINOS",
    title: "Condiciones de ",
    titleAccent: "uso de HorizAI.",
    intro: "Estos términos provisionales describen el uso esperado de HorizAI como producto editorial e informativo sobre inteligencia artificial.",
    callout: "Documento provisional para el MVP. Debe revisarse antes del lanzamiento público.",
    sections: [
      {
        heading: "Uso informativo",
        paragraphs: [
          "HorizAI ofrece contenidos de carácter informativo y editorial. No constituye asesoramiento legal, financiero, técnico o profesional, y cada persona debe valorar la información según su propio contexto.",
        ],
      },
      {
        heading: "Enlaces a terceros",
        paragraphs: [
          "Las historias pueden enlazar a sitios y fuentes externas. Esos sitios tienen sus propias condiciones y políticas; HorizAI no controla necesariamente su contenido, disponibilidad o cambios posteriores.",
        ],
      },
      {
        heading: "Propiedad intelectual",
        paragraphs: [
          "La identidad, interfaz y contenidos propios de HorizAI pertenecen a sus titulares. Las marcas, documentos e imágenes de terceros siguen perteneciendo a sus respectivos propietarios y se presentan con finalidad informativa.",
        ],
      },
      {
        heading: "Exactitud, disponibilidad y responsabilidad",
        paragraphs: [
          "Trabajamos para mantener la información actualizada y contextualizada, pero una noticia puede cambiar, contener errores o depender de fuentes externas. El servicio puede modificarse, interrumpirse o dejar de estar disponible sin garantía de continuidad.",
        ],
      },
      {
        heading: "Cambios del servicio",
        paragraphs: [
          "Estos términos y las funciones de HorizAI podrán actualizarse cuando el producto evolucione. La versión publicada en esta página será la referencia provisional hasta que exista una revisión legal definitiva.",
        ],
      },
    ],
  },
} as const satisfies Record<string, ContentPageData>;
