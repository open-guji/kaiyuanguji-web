import 'dart:io';

/// 资源验证脚本
/// 检查代码中引用的 Markdown 文件是否存在，以及 Frontmatter 格式是否正确
void main() async {
  print('🔍 开始检查资源文件...\n');

  var hasErrors = false;

  // 1. 检查 assets/content 目录
  hasErrors |= await checkContentDirectory();

  // 2. 检查代码中的文件引用
  hasErrors |= await checkCodeReferences();

  // 3. 检查 Frontmatter 格式
  hasErrors |= await checkFrontmatter();

  print('\n' + ('=' * 50));
  if (hasErrors) {
    print('❌ 检查完成，发现错误');
    exit(1);
  } else {
    print('✅ 检查完成，所有资源文件正常');
    exit(0);
  }
}

/// 检查 content 目录是否存在以及是否有内容
Future<bool> checkContentDirectory() async {
  print('📁 检查 content 目录...');

  final contentDir = Directory('assets/content');
  if (!await contentDir.exists()) {
    print('  ❌ assets/content 目录不存在');
    return true;
  }

  final files = await contentDir
      .list()
      .where((entity) => entity is File && entity.path.endsWith('.md'))
      .toList();

  if (files.isEmpty) {
    print('  ⚠️  assets/content 目录为空');
    return true;
  }

  print('  ✅ 找到 ${files.length} 个 Markdown 文件');
  return false;
}

/// 检查代码中的文件引用
Future<bool> checkCodeReferences() async {
  print('\n🔎 检查代码中的文件引用...');

  var hasErrors = false;

  // 需要检查的已知文件引用
  final knownReferences = [
    'home.md',
    'phase1.md',
    'phase2.md',
    'phase3.md',
    'phase4.md',
    'phase5.md',
    'chapter_1.md',
  ];

  for (final filename in knownReferences) {
    final file = File('assets/content/$filename');
    if (!await file.exists()) {
      print('  ❌ 文件不存在: $filename');
      hasErrors = true;
    } else {
      print('  ✅ $filename');
    }
  }

  return hasErrors;
}

/// 检查 Frontmatter 格式
Future<bool> checkFrontmatter() async {
  print('\n📄 检查 Frontmatter 格式...');

  var hasErrors = false;
  final contentDir = Directory('assets/content');

  await for (final entity in contentDir.list()) {
    if (entity is File && entity.path.endsWith('.md')) {
      final filename = entity.path.split(Platform.pathSeparator).last;
      final content = await entity.readAsString();

      // 检查是否有 Frontmatter
      if (!content.trimLeft().startsWith('---')) {
        print('  ⚠️  $filename: 缺少 Frontmatter');
        continue;
      }

      // 提取 Frontmatter
      final parts = content.trimLeft().substring(3).split('---');
      if (parts.isEmpty) {
        print('  ❌ $filename: Frontmatter 格式错误（缺少结束标记）');
        hasErrors = true;
        continue;
      }

      final frontmatter = parts[0].trim();

      // 检查是否有 title 字段
      if (!frontmatter.contains(RegExp(r'^title:\s*.+', multiLine: true))) {
        print('  ⚠️  $filename: Frontmatter 缺少 title 字段');
      } else {
        print('  ✅ $filename');
      }
    }
  }

  return hasErrors;
}
