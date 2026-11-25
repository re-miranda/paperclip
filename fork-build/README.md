# fork-build (Gambiarra, MIR-2027)

Orphan branch `fork-build`. To build a commit: edit `fork-build/request.json` (`sha` = full 40-char commit already on the fork,
`label`, `version` = YYYY.MMDD.N for the base release, `tests` = repo-relative test files), commit, push the branch.
The push starts workflow "Fork build". Artifact `fork-build-<label>-<sha>` holds `payload.tar.gz`, `source.tar.gz`, `SHA256SUMS`, `BUILD-INFO.txt`.
Never merge this branch into master/main. No secrets, nothing is published.
