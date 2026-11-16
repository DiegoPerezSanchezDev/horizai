import { ImageResponse } from "next/og";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          padding: "76px 88px",
          color: "#f7faff",
          background: "linear-gradient(135deg, #040914 0%, #071831 68%, #0a2340 100%)",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            position: "absolute",
            right: "-98px",
            top: "95px",
            width: "430px",
            height: "430px",
            border: "1px solid rgba(72, 160, 255, 0.3)",
            borderRadius: "50%",
          }}
        />
        <div
          style={{
            display: "flex",
            position: "absolute",
            right: "-28px",
            top: "165px",
            width: "290px",
            height: "290px",
            border: "1px solid rgba(72, 160, 255, 0.22)",
            borderRadius: "50%",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ color: "#79b9ff", fontSize: "24px", fontWeight: 600, letterSpacing: "0.16em" }}>
            INTELIGENCIA GLOBAL
          </div>
          <div style={{ display: "flex", marginTop: "24px", fontSize: "100px", fontWeight: 700, letterSpacing: "-0.055em" }}>
            <span>Horiz</span><span style={{ color: "#4ca4ff" }}>AI</span>
          </div>
          <div style={{ marginTop: "18px", fontSize: "40px", fontWeight: 600 }}>
            Noticias sobre inteligencia artificial
          </div>
          <div style={{ marginTop: "18px", color: "#a9bdd2", fontSize: "27px" }}>
            En español, con contexto y fuentes originales.
          </div>
          <div style={{ display: "flex", width: "84px", height: "4px", marginTop: "34px", background: "#3799ff" }} />
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
