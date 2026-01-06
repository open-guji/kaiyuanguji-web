import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../core/layout/layout_shell.dart';
import 'package:google_fonts/google_fonts.dart';

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

  @override
  Widget build(BuildContext context) {
    return LayoutShell(
      title: '开源古籍',
      child: FadeTransition(
        opacity: _fadeAnimation,
        child: SingleChildScrollView(
          primary: true,
          child: Column(
            children: [
              const _HeroSection(),
              const _VisionSection(),
              const _WorkflowSection(),
              const _RoadmapSection(),
              const _ExploreSection(),
              const SizedBox(height: 100),
            ],
          ),
        ),
      ),
    );
  }
}

/// 英雄区：项目门户
class _HeroSection extends StatelessWidget {
  const _HeroSection();

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final isMobile = size.width < 600;

    return Container(
      width: double.infinity,
      height: isMobile ? 500 : 700,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            AppTheme.paperBackground,
            AppTheme.borderColor.withValues(alpha: 0.3),
            AppTheme.paperBackground,
          ],
        ),
      ),
      child: Stack(
        children: [
          // 背景图 - 使用生成的英雄图
          Positioned.fill(
            child: Opacity(
              opacity: 0.2,
              child: Image.asset('assets/images/hero.png', fit: BoxFit.cover),
            ),
          ),
          // 内容层
          Center(
            child: Container(
              constraints: const BoxConstraints(maxWidth: 1000),
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    '开源古籍',
                    style: Theme.of(context).textTheme.displayLarge?.copyWith(
                      fontSize: isMobile ? 48 : 72,
                      letterSpacing: 10,
                      color: AppTheme.inkBlack,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  Text(
                    '让科技赋予古籍数字生命',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      color: AppTheme.secondaryGray,
                      letterSpacing: 2,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 16),
                  Container(width: 60, height: 2, color: AppTheme.vermilionRed),
                  const SizedBox(height: 32),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 48),
                    child: Text(
                      '通过技术手段推动古籍的数字化、校对及开源存储，构建古籍知识图谱与 AI 模型',
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: AppTheme.inkBlack.withValues(alpha: 0.7),
                        height: 2.0,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: 48),
                  Wrap(
                    spacing: 16,
                    runSpacing: 16,
                    alignment: WrapAlignment.center,
                    children: [
                      ElevatedButton(
                        onPressed: () => context.go('/roadmap'),
                        style: ElevatedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 40,
                            vertical: 20,
                          ),
                        ),
                        child: const Text('开始探索'),
                      ),
                      OutlinedButton(
                        onPressed: () => context.go('/assistant'),
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 40,
                            vertical: 20,
                          ),
                          side: const BorderSide(color: AppTheme.vermilionRed),
                          foregroundColor: AppTheme.vermilionRed,
                        ),
                        child: const Text('开发工具'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 愿景区：核心支柱
class _VisionSection extends StatelessWidget {
  const _VisionSection();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 80, horizontal: 24),
      color: Colors.white,
      child: Column(
        children: [
          const _SectionHeader(
            title: '项目愿景',
            subtitle: '构建从“数字化排版”到“高精度校对”的完整闭环',
          ),
          const SizedBox(height: 60),
          LayoutBuilder(
            builder: (context, constraints) {
              final isWide = constraints.maxWidth > 800;
              return GridView.count(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                crossAxisCount: isWide ? 3 : 1,
                mainAxisSpacing: 32,
                crossAxisSpacing: 32,
                childAspectRatio: isWide ? 0.8 : 1.3,
                children: const [
                  _VisionCard(
                    title: '专业排版',
                    description: '利用 LaTeX 引擎深度还原古籍之美，支持纵排、双行小注等复杂版式。',
                    icon: Icons.auto_stories_outlined,
                    imagePath: 'assets/images/typesetting.png',
                  ),
                  _VisionCard(
                    title: '智能助手',
                    description: '集成最先进的古籍 OCR 与句读模型，大幅提高文字录入与标点效率。',
                    icon: Icons.psychology_outlined,
                    imagePath: 'assets/images/ocr.png',
                  ),
                  _VisionCard(
                    title: '知识图谱',
                    description: '构建深度知识系统，训练专用 AI 大模型，推动古籍数字化走向智能化研究。',
                    icon: Icons.hub_outlined,
                    imagePath: 'assets/images/intelligence.png',
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

/// 工作流区：数字化流程
class _WorkflowSection extends StatelessWidget {
  const _WorkflowSection();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 80, horizontal: 24),
      decoration: const BoxDecoration(
        color: AppTheme.paperBackground,
        border: Border.symmetric(
          horizontal: BorderSide(color: AppTheme.borderColor, width: 0.5),
        ),
      ),
      child: Column(
        children: [
          const _SectionHeader(title: 'AI 辅助工作流', subtitle: '全链路自动化的数字化解决方案'),
          const SizedBox(height: 60),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _buildStep(context, '01', '图像预处理', '纠简、去噪、设版心'),
                _buildArrow(),
                _buildStep(context, '02', '版面分析', '识别文本与批注区域'),
                _buildArrow(),
                _buildStep(context, '03', 'OCR 文字识别', '精准转录、置信度评估'),
                _buildArrow(),
                _buildStep(context, '04', 'AI 自动句读', '智能断句、标点映射'),
                _buildArrow(),
                _buildStep(context, '05', '人工校验', '基于 Git 的精细化校对'),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStep(
    BuildContext context,
    String num,
    String title,
    String desc,
  ) {
    return Container(
      width: 200,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        children: [
          Text(
            num,
            style: GoogleFonts.montserrat(
              fontSize: 32,
              fontWeight: FontWeight.bold,
              color: AppTheme.vermilionRed.withValues(alpha: 0.2),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            title,
            style: Theme.of(
              context,
            ).textTheme.headlineSmall?.copyWith(fontSize: 16),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            desc,
            style: Theme.of(context).textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  Widget _buildArrow() {
    return const Padding(
      padding: EdgeInsets.symmetric(horizontal: 12),
      child: Icon(
        Icons.arrow_forward_ios,
        color: AppTheme.borderColor,
        size: 20,
      ),
    );
  }
}

/// 路线图区
class _RoadmapSection extends StatelessWidget {
  const _RoadmapSection();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 80, horizontal: 24),
      color: Colors.white,
      child: Column(
        children: [
          const _SectionHeader(
            title: '五阶段路线图',
            subtitle: '从数字化排版逐步走向 AI 智能化研究',
          ),
          const SizedBox(height: 60),
          _buildRoadmapItem(
            context,
            '第一层：古籍排版',
            '实现符合古籍审美与学术规范的数字动态排版。支持纵排、双行小注等。',
            '🔨 进行中',
            0,
          ),
          _buildRoadmapItem(
            context,
            '第二层：自动化提取',
            '集成 OCR、版面分析与自动标点，大幅降低录入成本。',
            '📋 规划中',
            1,
          ),
          _buildRoadmapItem(
            context,
            '第三层：数字化工具',
            '建立图文对照、异体字映射的高效率协作环境。',
            '🔨 进行中',
            2,
          ),
          _buildRoadmapItem(
            context,
            '第四层：开源存储',
            '采用标准格式存储，参考维基文库建立社区驱动的审核机制。',
            '📋 规划中',
            3,
          ),
          _buildRoadmapItem(
            context,
            '第五层：知识图谱',
            '构建深度知识图谱，训练专用 AI 大模型，推动智能化研究。',
            '📋 规划中',
            4,
          ),
        ],
      ),
    );
  }

  Widget _buildRoadmapItem(
    BuildContext context,
    String title,
    String desc,
    String status,
    int index,
  ) {
    final isOdd = index % 2 == 1;
    final isMobile = MediaQuery.of(context).size.width < 600;

    return Padding(
      padding: const EdgeInsets.only(bottom: 40),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isMobile && !isOdd) const Spacer(),
          if (!isMobile) ...[
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: status.contains('进行中')
                    ? AppTheme.vermilionRed
                    : AppTheme.borderColor,
                shape: BoxShape.circle,
              ),
              child: Center(
                child: Text(
                  '${index + 1}',
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 24),
          ],
          Expanded(
            flex: 2,
            child: Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: AppTheme.paperBackground.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: AppTheme.borderColor.withValues(alpha: 0.5),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        title,
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(color: AppTheme.borderColor),
                        ),
                        child: Text(
                          status,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(desc, style: Theme.of(context).textTheme.bodyMedium),
                ],
              ),
            ),
          ),
          if (!isMobile && isOdd) const Spacer(),
        ],
      ),
    );
  }
}

/// 底部探索区
class _ExploreSection extends StatelessWidget {
  const _ExploreSection();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 80),
      decoration: const BoxDecoration(color: AppTheme.inkBlack),
      child: Column(
        children: [
          Text(
            '开始探索',
            style: Theme.of(
              context,
            ).textTheme.displaySmall?.copyWith(color: Colors.white),
          ),
          const SizedBox(height: 40),
          Wrap(
            spacing: 24,
            runSpacing: 24,
            children: [
              _buildExploreButton(
                context,
                '古籍助手',
                Icons.auto_awesome,
                '/assistant',
              ),
              _buildExploreButton(context, '路线图', Icons.map, '/roadmap'),
              _buildExploreButton(
                context,
                '项目源码',
                Icons.code,
                'https://github.com/sheldonlidev/kaiyuanguji',
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildExploreButton(
    BuildContext context,
    String label,
    IconData icon,
    String path,
  ) {
    return InkWell(
      onTap: () {
        if (path.startsWith('http')) {
          // TODO: Open URL
        } else {
          context.go(path);
        }
      },
      child: Container(
        width: 150,
        padding: const EdgeInsets.symmetric(vertical: 24),
        decoration: BoxDecoration(
          border: Border.all(color: Colors.white.withValues(alpha: 0.2)),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          children: [
            Icon(icon, color: Colors.white, size: 32),
            const SizedBox(height: 12),
            Text(label, style: const TextStyle(color: Colors.white)),
          ],
        ),
      ),
    );
  }
}

/// 通用章节头部
class _SectionHeader extends StatelessWidget {
  final String title;
  final String subtitle;

  const _SectionHeader({required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(
          title,
          style: Theme.of(context).textTheme.displaySmall?.copyWith(
            letterSpacing: 4,
            fontWeight: FontWeight.bold,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        Text(
          subtitle,
          style: Theme.of(
            context,
          ).textTheme.bodyLarge?.copyWith(color: AppTheme.secondaryGray),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        Container(width: 40, height: 3, color: AppTheme.vermilionRed),
      ],
    );
  }
}

/// 愿景卡片
class _VisionCard extends StatefulWidget {
  final String title;
  final String description;
  final IconData icon;
  final String? imagePath;

  const _VisionCard({
    required this.title,
    required this.description,
    required this.icon,
    this.imagePath,
  });

  @override
  State<_VisionCard> createState() => _VisionCardState();
}

class _VisionCardState extends State<_VisionCard> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(
              color: AppTheme.inkBlack.withValues(
                alpha: _isHovered ? 0.1 : 0.05,
              ),
              blurRadius: _isHovered ? 30 : 15,
              offset: Offset(0, _isHovered ? 12 : 8),
            ),
          ],
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            // 图片背景层
            if (widget.imagePath != null)
              Expanded(
                flex: 4,
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: Image.asset(widget.imagePath!, fit: BoxFit.cover),
                    ),
                    Positioned.fill(
                      child: Container(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              Colors.transparent,
                              Colors.white.withValues(alpha: 0.8),
                              Colors.white,
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            // 内容层
            Expanded(
              flex: 5,
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(widget.icon, size: 40, color: AppTheme.vermilionRed),
                    const SizedBox(height: 16),
                    Text(
                      widget.title,
                      style: Theme.of(context).textTheme.headlineSmall,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      widget.description,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppTheme.secondaryGray,
                        height: 1.5,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
