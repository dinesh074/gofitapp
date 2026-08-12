import React, { useRef } from "react";
import {
  Animated,
  GestureResponderEvent,
  Pressable,
  PressableProps,
  StyleProp,
  ViewStyle,
} from "react-native";

type Props = PressableProps & {
  style?: StyleProp<ViewStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
  children?: React.ReactNode;
};

/**
 * Pressable with a subtle spring scale on press — used on primary CTAs to give
 * tactile feedback without pulling in reanimated.
 */
export default function PressableScale({
  style,
  containerStyle,
  scaleTo = 0.96,
  onPressIn,
  onPressOut,
  children,
  ...rest
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (to: number) =>
    Animated.spring(scale, {
      toValue: to,
      useNativeDriver: true,
      speed: 40,
      bounciness: 6,
    }).start();

  const handleIn = (e: GestureResponderEvent) => {
    animate(scaleTo);
    onPressIn?.(e);
  };
  const handleOut = (e: GestureResponderEvent) => {
    animate(1);
    onPressOut?.(e);
  };

  return (
    <Pressable style={containerStyle} onPressIn={handleIn} onPressOut={handleOut} {...rest}>
      <Animated.View style={[{ transform: [{ scale }] }, style]}>{children}</Animated.View>
    </Pressable>
  );
}
