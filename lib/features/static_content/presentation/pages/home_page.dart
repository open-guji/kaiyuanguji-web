import 'package:flutter/material.dart';
import '../../../../core/layout/layout_shell.dart';
import '../widgets/home/hero_section.dart';
import '../widgets/home/roadmap_section.dart';
import '../widgets/home/assistant_section.dart';
import '../widgets/home/book_index_section.dart';
import '../widgets/home/join_section.dart';

/// 首页
/// 使用现代、原生的 Flutter UI 重新设计
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage>
    with SingleTickerProviderStateMixin {
  late AnimationController _fadeController;
  late Animation<double> _fadeAnimation;

  final GlobalKey _roadmapKey = GlobalKey();
  final GlobalKey _assistantKey = GlobalKey();
  final GlobalKey _joinKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    _fadeController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    );
    _fadeAnimation = CurvedAnimation(
      parent: _fadeController,
      curve: Curves.easeIn,
    );
    _fadeController.forward();
  }

  @override
  void dispose() {
    _fadeController.dispose();
    super.dispose();
  }

  void _scrollToSection(GlobalKey key) {
    final context = key.currentContext;
    if (context != null) {
      Scrollable.ensureVisible(
        context,
        duration: const Duration(milliseconds: 800),
        curve: Curves.easeInOut,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutShell(
      title: '开源古籍',
      onRoadmapTap: () => _scrollToSection(_roadmapKey),
      onAssistantTap: () => _scrollToSection(_assistantKey),
      onJoinTap: () => _scrollToSection(_joinKey),
      child: FadeTransition(
        opacity: _fadeAnimation,
        child: SingleChildScrollView(
          primary: true,
          child: Column(
            children: [
              HeroSection(
                onRoadmapTap: () => _scrollToSection(_roadmapKey),
                onAssistantTap: () => _scrollToSection(_assistantKey),
                onJoinTap: () => _scrollToSection(_joinKey),
              ),
              RoadmapSection(key: _roadmapKey),
              AssistantSection(key: _assistantKey),
              const BookIndexSection(),
              JoinSection(key: _joinKey),
              LayoutShell.buildFooter(context),
            ],
          ),
        ),
      ),
    );
  }
}
