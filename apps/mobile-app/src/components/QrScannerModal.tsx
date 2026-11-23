import React, { useEffect, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import type { CodexPalette } from "../theme";

interface Props {
  visible: boolean;
  palette: CodexPalette;
  onScanned: (rawText: string) => void;
  onClose: () => void;
}

export function QrScannerModal({ visible, palette, onScanned, onClose }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (visible) {
      setLocked(false);
      if (permission && !permission.granted && permission.canAskAgain) {
        requestPermission().catch(() => {});
      }
    }
  }, [visible, permission, requestPermission]);

  const handleBarcode = ({ data }: { data: string }) => {
    if (locked || !data) return;
    setLocked(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onScanned(data);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: "#0D0D0D" }]}>
        <View style={styles.header}>
          <Text style={styles.title}>扫描 PI-Desktop 配对二维码</Text>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeText}>关闭</Text>
          </TouchableOpacity>
        </View>

        {!permission?.granted ? (
          <View style={styles.center}>
            <Text style={styles.hint}>需要相机权限来扫描电脑端的 120 秒一次性配对码。</Text>
            <TouchableOpacity
              style={[styles.permBtn, { backgroundColor: palette.accent }]}
              onPress={() => requestPermission().catch(() => {})}
            >
              <Text style={{ color: palette.accentFg, fontWeight: "700", fontSize: 14 }}>授予相机权限</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={handleBarcode}
            />
            <View style={styles.overlay}>
              <View style={styles.frame} />
              <Text style={styles.scanTip}>将电脑屏幕上的配对二维码放入框内</Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingTop: 52,
    paddingBottom: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#0D0D0D",
  },
  title: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  closeText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 16,
  },
  hint: { color: "#CCCCCC", fontSize: 14, textAlign: "center", lineHeight: 21 },
  permBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 10 },
  cameraWrap: { flex: 1, position: "relative" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
  },
  frame: {
    width: 240,
    height: 240,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    backgroundColor: "transparent",
  },
  scanTip: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.58)",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
  },
});
