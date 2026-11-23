import React, { useEffect, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { CodexPalette } from "../theme";

interface Props {
  visible: boolean;
  palette: CodexPalette;
  title: string;
  subtitle?: string;
  tall?: boolean;
  headerRight?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

export function BottomSheet({
  visible,
  palette,
  title,
  subtitle,
  tall = false,
  headerRight,
  onClose,
  children,
}: Props) {
  const slideY = useRef(new Animated.Value(380)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      slideY.setValue(380);
      fade.setValue(0);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(slideY, {
          toValue: 0,
          damping: 22,
          stiffness: 240,
          mass: 0.9,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, fade, slideY]);

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { backgroundColor: palette.backdrop, opacity: fade }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: palette.surface,
              borderTopColor: palette.borderStrong,
              maxHeight: tall ? "86%" : "76%",
              transform: [{ translateY: slideY }],
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: palette.borderStrong }]} />
          <View style={[styles.head, { borderBottomColor: palette.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
              {subtitle ? <Text style={[styles.sub, { color: palette.textSecondary }]}>{subtitle}</Text> : null}
            </View>
            <View style={styles.headRight}>
              {headerRight}
              <TouchableOpacity
                style={[styles.closeBtn, { backgroundColor: palette.surface2, borderColor: palette.border }]}
                onPress={onClose}
              >
                <Text style={{ color: palette.textSecondary, fontSize: 13, fontWeight: "700" }}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    width: "100%",
    borderTopWidth: 1,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: "hidden",
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 999,
    alignSelf: "center",
    marginTop: 9,
    marginBottom: 4,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 10,
  },
  headRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
  },
  sub: {
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flexGrow: 0,
  },
  bodyContent: {
    padding: 16,
    paddingBottom: 32,
    gap: 10,
  },
});
