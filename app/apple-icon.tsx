import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          borderRadius: "32px",
          background: "linear-gradient(145deg, #3d7dff 0%, #1546d4 100%)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            width: "112px",
            height: "112px",
            border: "5px solid #ffffff",
            borderRadius: "50%",
          }}
        >
          <div
            style={{
              display: "flex",
              position: "absolute",
              width: "112px",
              height: "5px",
              background: "#ffffff",
            }}
          />
          <div
            style={{
              display: "flex",
              position: "absolute",
              width: "56px",
              height: "112px",
              border: "5px solid #ffffff",
              borderRadius: "50%",
            }}
          />
        </div>
      </div>
    ),
    size,
  );
}
