export function goBackOrTabs(navigation: any) {
  if (navigation?.canGoBack?.()) {
    navigation.goBack();
    return;
  }
  navigation?.navigate?.("Tabs");
}

