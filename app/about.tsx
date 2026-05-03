import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';

// ── Types ─────────────────────────────────────────────────────────────────────

type DetailType = 'privacy' | 'terms' | 'oss' | null;

// ── Titles ────────────────────────────────────────────────────────────────────

const DETAIL_TITLES: Record<Exclude<DetailType, null>, string> = {
  privacy: '개인정보 처리방침',
  terms:   '이용약관',
  oss:     '오픈소스 라이선스',
};

// ── Content ───────────────────────────────────────────────────────────────────
// [H] = heading, [L] = link, plain = paragraph

const DETAIL_CONTENT: Record<Exclude<DetailType, null>, string[]> = {
  privacy: [
    '[H]개인정보 처리방침',
    'RealtimeSub은 사용자의 개인정보를 소중히 여기며, 관련 법령을 준수합니다.',
    '[H]수집 항목',
    '- 이메일 주소 (Firebase 인증)\n- 앱 사용 데이터 (번역 사용량, 플랜 정보)',
    '[H]수집 목적',
    '- 사용자 인증 및 계정 관리\n- 서비스 제공 및 사용량 제한 관리\n- 구독 서비스 처리 (RevenueCat)',
    '[H]제3자 제공',
    '수집된 정보는 서비스 운영에 필요한 경우에 한해 아래 업체와 공유될 수 있습니다.\n- Firebase (Google): 인증 및 데이터 저장\n- RevenueCat: 구독 결제 처리',
    '[H]보관 기간',
    '회원 탈퇴 시 즉시 삭제됩니다.',
    '[H]문의',
    '앱 내 고객지원 화면을 통해 문의하실 수 있습니다.',
    '본 방침은 추후 업데이트될 수 있습니다.',
  ],
  terms: [
    '[H]이용약관',
    '본 약관은 RealtimeSub 앱 사용에 관한 조건을 규정합니다.',
    '[H]서비스 이용',
    '- 본 앱은 개인 비상업적 목적으로만 사용할 수 있습니다.\n- 불법적인 목적으로 사용하거나 서비스를 남용하는 행위를 금지합니다.\n- 번역 결과물을 유일한 정보 출처로 사용하지 마세요.',
    '[H]계정',
    '- 정확한 정보로 가입하셔야 합니다.\n- 계정 보안은 사용자 본인의 책임입니다.',
    '[H]유료 서비스',
    '- 구독 요금은 선택한 플랜에 따라 부과됩니다.\n- 구독은 언제든지 취소할 수 있습니다.\n- 환불은 관련 앱스토어 정책을 따릅니다.',
    '[H]면책조항',
    '번역 결과의 정확성을 보장하지 않습니다. 중요한 결정에는 전문 번역을 이용하세요.',
    '본 약관은 추후 업데이트될 수 있습니다.',
  ],
  oss: [
    '[H]오픈소스 라이선스',
    'RealtimeSub은 아래 오픈소스 소프트웨어를 사용합니다.',
    '[H]React Native',
    'License: MIT',
    '[L]https://github.com/facebook/react-native',
    '[H]Expo',
    'License: MIT',
    '[L]https://github.com/expo/expo',
    '[H]whisper.rn',
    'License: MIT',
    '[L]https://github.com/mybigday/whisper.rn',
    '[H]llama.rn',
    'License: MIT',
    '[L]https://github.com/mybigday/llama.rn',
    '[H]Gemma (Google)',
    'License: Apache 2.0',
    '[L]https://github.com/google-deepmind/gemma',
    '[H]Zustand',
    'License: MIT',
    '[L]https://github.com/pmndrs/zustand',
    '[H]i18next',
    'License: MIT',
    '[L]https://github.com/i18next/i18next',
    '[H]react-native-purchases (RevenueCat)',
    'License: MIT',
    '[L]https://github.com/RevenueCat/react-native-purchases',
    '[H]React Native Firebase',
    'License: Apache 2.0',
    '[L]https://github.com/invertase/react-native-firebase',
    '[H]lucide-react-native',
    'License: ISC',
    '[L]https://github.com/lucide-icons/lucide',
    '각 라이브러리의 전체 라이선스 내용은 해당 GitHub 저장소에서 확인하실 수 있습니다.',
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const openUrl = async (url: string) => {
  const supported = await Linking.canOpenURL(url);
  if (supported) Linking.openURL(url);
};

const handleBack = () => {
  if (router.canGoBack()) router.back();
  else router.replace('/');
};

// ── Root component ────────────────────────────────────────────────────────────

export default function AboutScreen() {
  const [detail, setDetail] = useState<DetailType>(null);

  if (detail !== null) {
    return <DetailScreen type={detail} onBack={() => setDetail(null)} />;
  }
  return <AboutList onSelect={setDetail} />;
}

// ── AboutList ─────────────────────────────────────────────────────────────────

function AboutList({ onSelect }: { onSelect: (d: DetailType) => void }) {
  const menuItems: { key: Exclude<DetailType, null>; label: string }[] = [
    { key: 'privacy', label: DETAIL_TITLES.privacy },
    { key: 'terms',   label: DETAIL_TITLES.terms   },
    { key: 'oss',     label: DETAIL_TITLES.oss     },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerBack} onPress={handleBack} activeOpacity={0.7}>
          <ChevronLeft size={22} color="#aaa" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>앱 정보</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        <View style={styles.bannerWrapper}>
          <Image
            source={require('../assets/about_icon.png')}
            style={styles.bannerImage}
            resizeMode="cover"
          />
        </View>

        {/* Menu rows */}
        {menuItems.map((item) => (
          <TouchableOpacity
            key={item.key}
            style={styles.menuCard}
            onPress={() => onSelect(item.key)}
            activeOpacity={0.7}
          >
            <Text style={styles.menuLabel}>{item.label}</Text>
            <Text style={styles.menuChevron}>›</Text>
          </TouchableOpacity>
        ))}

        {/* Website row */}
        <TouchableOpacity
          style={styles.menuCard}
          onPress={() => openUrl('https://realtimesub.com')}
          activeOpacity={0.7}
        >
          <Text style={styles.menuLabel}>공식 웹사이트</Text>
          <Text style={styles.websiteUrl}>realtimesub.com</Text>
        </TouchableOpacity>

        <Text style={styles.copyright}>© 2025–2026 RealtimeSub. All rights reserved.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── DetailScreen ──────────────────────────────────────────────────────────────

function DetailScreen({
  type,
  onBack,
}: {
  type: Exclude<DetailType, null>;
  onBack: () => void;
}) {
  const renderBlock = (raw: string, i: number) => {
    if (raw.startsWith('[H]')) {
      return (
        <Text key={i} style={styles.detailHeading}>
          {raw.slice(3)}
        </Text>
      );
    }
    if (raw.startsWith('[L]')) {
      const url = raw.slice(3);
      return (
        <Text
          key={i}
          style={styles.detailLink}
          onPress={() => openUrl(url)}
        >
          {url}
        </Text>
      );
    }
    return (
      <Text key={i} style={styles.detailPara}>
        {raw}
      </Text>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerBack} onPress={onBack} activeOpacity={0.7}>
          <ChevronLeft size={22} color="#aaa" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{DETAIL_TITLES[type]}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.detailContent} showsVerticalScrollIndicator={false}>
        {DETAIL_CONTENT[type].map((block, i) => renderBlock(block, i))}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: '#0a0a0a' },

  header:        { height: 44, justifyContent: 'center', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a2a2a' },
  headerBack:    { position: 'absolute', left: 8, width: 36, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerTitle:   { color: '#fff', fontSize: 16, fontWeight: '700' },

  content:       { padding: 16, paddingBottom: 40 },

  bannerWrapper: { width: '100%', height: 220, borderRadius: 12, overflow: 'hidden', marginBottom: 12 },
  bannerImage:   { width: '100%', height: 238, marginTop: -8 },

  menuCard:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#141414', borderRadius: 12, paddingVertical: 16, paddingHorizontal: 16, marginBottom: 12, borderWidth: 1, borderColor: '#2a2a2a' },
  menuLabel:     { color: '#ccc', fontSize: 15 },
  menuChevron:   { color: '#555', fontSize: 20 },
  websiteUrl:    { color: '#888', fontSize: 13 },
  copyright:     { color: '#444', fontSize: 12, textAlign: 'center', marginTop: 8, marginBottom: 24 },

  detailContent: { padding: 20, paddingBottom: 40 },
  detailHeading: { color: '#fff', fontSize: 15, fontWeight: '700', marginTop: 20, marginBottom: 6 },
  detailPara:    { color: '#ccc', fontSize: 14, lineHeight: 24, marginBottom: 8 },
  detailLink:    { color: '#5a82b0', fontSize: 13, lineHeight: 20, marginTop: 2, marginBottom: 12 },
});
