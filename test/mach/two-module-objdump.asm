
/app/out/obj/example/example.o:     file format elf64-x86-64


Disassembly of section .text:

0000000000000000 <example.example.main>:
main():
/app/src/example.mach:4
   0:	55                   	push   %rbp
   1:	48 89 e5             	mov    %rsp,%rbp
   4:	48 83 ec 50          	sub    $0x50,%rsp
   8:	48 89 5d b8          	mov    %rbx,-0x48(%rbp)
/app/src/example.mach:5
   c:	48 8d 5d c8          	lea    -0x38(%rbp),%rbx
  10:	48 8d 35 00 00 00 00 	lea    0x0(%rip),%rsi        # 17 <example.example.main+0x17>
  17:	48 89 df             	mov    %rbx,%rdi
  1a:	e8 00 00 00 00       	call   1f <example.example.main+0x1f>
/app/src/example.mach:6
  1f:	48 c7 c7 03 00 00 00 	mov    $0x3,%rdi
  26:	e8 00 00 00 00       	call   2b <example.example.main+0x2b>
  2b:	48 8b 5d b8          	mov    -0x48(%rbp),%rbx
  2f:	48 89 ec             	mov    %rbp,%rsp
  32:	5d                   	pop    %rbp
  33:	c3                   	ret

/app/out/obj/example/util/fmt.o:     file format elf64-x86-64


Disassembly of section .text:

0000000000000000 <example.util.fmt.twice>:
twice():
/app/src/util/fmt.mach:2
   0:	48 6b ff 02          	imul   $0x2,%rdi,%rdi
   4:	48 89 f8             	mov    %rdi,%rax
   7:	c3                   	ret

0000000000000008 <example.util.fmt.unused>:
unused():
/app/src/util/fmt.mach:6
   8:	48 83 c7 07          	add    $0x7,%rdi
   c:	48 89 f8             	mov    %rdi,%rax
   f:	c3                   	ret
