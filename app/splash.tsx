import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  Image,
  Animated,
  StyleSheet,
  Dimensions,
} from "react-native";

const { width, height } = Dimensions.get("window");

const LOADING_HINTS = [
  "Optimizing AI engine...",
  "Loading speech recognition...",
  "Initializing translation engine...",
  "Checking subtitle cache...",
];

export default function SplashScreen() {
  const fadeAnim    = useRef(new Animated.Value(0)).current;
  const barWidth    = useRef(new Animated.Value(0)).current;
  const hintOpacity = useRef(new Animated.Value(0)).current;
  const [hintIndex, setHintIndex] = React.useState(0);

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();

    Animated.timing(barWidth, {
      toValue: width * 0.55,
      duration: 2800,
      useNativeDriver: false,
    }).start();

    const cycleHint = () => {
      Animated.sequence([
        Animated.timing(hintOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.delay(700),
        Animated.timing(hintOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start(() => {
        setHintIndex((prev) => (prev + 1) % LOADING_HINTS.length);
        cycleHint();
      });
    };
    cycleHint();
  }, []);

  return (
    <View style={styles.container}>
      {/* Full background image */}
      <Image
        source={require("../assets/splash_icon.png")}
        style={styles.bgImage}
        resizeMode="cover"
      />

      {/* Dark fade overlay at bottom */}
      <View style={styles.bottomOverlay} />

      {/* Loading area at bottom */}
      <Animated.View style={[styles.loadingArea, { opacity: fadeAnim }]}>
        <Animated.Text style={[styles.hint, { opacity: hintOpacity }]}>
          {LOADING_HINTS[hintIndex]}
        </Animated.Text>
        <View style={styles.barTrack}>
          <Animated.View style={[styles.barFill, { width: barWidth }]} />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  bgImage: {
    position: "absolute",
    top: 0,
    left: 0,
    width: width,
    height: height,
  },
  bottomOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 180,
    backgroundColor: "#0a0a0a",
    opacity: 0.85,
  },
  loadingArea: {
    position: "absolute",
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 8,
  },
  hint: {
    color: "#aaa",
    fontSize: 11,
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  barTrack: {
    width: width * 0.55,
    height: 1.5,
    backgroundColor: "#2a2a2a",
    borderRadius: 2,
    overflow: "hidden",
  },
  barFill: {
    height: 1.5,
    backgroundColor: "#2563eb",
    borderRadius: 2,
  },
});
