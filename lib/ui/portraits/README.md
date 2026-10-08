# 三套可切换立绘

使用内置 imagegen，根据用户提供的三张参考图制作。输出为带 alpha 透明通道的 PNG；保留原参考的服装和姿态，移除视频背景、播放按钮和文字，并修复遮挡区域。没有把源图作者或角色设计宣称为项目原创。原有动画素材的来源与署名见根目录 THIRD_PARTY_NOTICES.md。

| 文件 | 对应参考 |
| --- | --- |
| maid-short.png | 第一张：短裙女仆，双手放在下巴前，尾巴盘绕 |
| maid-long.png | 第二张：长裙女仆，一手提裙，一手抬起 |
| evening.png | 第三张：黑色礼服、手套、小礼帽 |

这些立绘搭配渲染层的动作和特效使用，不是逐帧角色动画。

## 实际生成提示

每次编辑使用一张对应的用户参考图，设置 transparent_background=true，使用以下共同提示，将 <PER-CHARACTER DETAIL> 替换为后面的对应段落：

```text
Use case: background-extraction and precise-object-edit.
Asset type: transparent full body character portrait for a desktop pet application.
The attached image is the edit target. Preserve the exact blue-haired whale maid character identity, face, hairstyle, colors, clothing design, pose, illustration style and proportions. <PER-CHARACTER DETAIL>.
Remove the white background, bottom gray video gradient, overlaid white play triangle and any caption/text. Restore only the fabric or body details hidden by those overlays. Do not redesign the character. Output exactly one isolated full body character with a true transparent alpha background, generous 3% clear margin on all sides, complete hair, tail, dress, hands and shoes. No text, symbols, extra props, ground, backdrop, cast shadow panel, grid, checkerboard pattern or UI. Keep existing white apron and white lace opaque.
```

- maid-short: short navy maid dress, white apron, bare legs, clasped hands beneath chin, curled blue whale tail across the lower foreground; reconstruct the very bottom shoes cleanly if clipped
- maid-long: long navy and white maid dress, whale emblem on apron, smiling, one hand holding skirt and one hand raised, blue whale tail on right
- evening: elegant black lace evening gown with subtle gold details and slit, black gloves and tilted small black floral hat, blue whale tail on right; preserve full length gown and feet

